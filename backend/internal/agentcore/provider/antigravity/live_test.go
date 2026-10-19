package antigravity

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// Opt-in: real prompts consume the operator's agy quota; ordinary tests use fixtures.
func TestLiveAntigravityChat(t *testing.T) {
	if os.Getenv("DEVDECK_AGY_LIVE") != "1" {
		t.Skip("set DEVDECK_AGY_LIVE=1 to use the current agy account")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	a, err := Driver{}.Create(ctx, provider.InstanceSpec{InstanceID: "antigravity:live", Config: Config{BinaryName: "agy"}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.StopAll(context.Background())
	start := provider.SessionStartInput{ThreadID: "smoke", Cwd: t.TempDir(), Mode: provider.ModeAuto, Interact: provider.InteractionPlan}
	if _, err := a.StartSession(ctx, start); err != nil {
		t.Fatal(err)
	}
	var resume json.RawMessage
	run := func(turn, prompt string, interrupt bool) (string, *event.TurnCompletedPayload) {
		t.Helper()
		_, err := a.SendTurn(ctx, provider.SendTurnInput{ThreadID: "smoke", TurnID: turn, Text: prompt, Model: provider.ModelSelection{Model: "gemini-3.8-flash-low"}})
		if err != nil {
			t.Fatal(err)
		}
		var text strings.Builder
		for {
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case ev := <-a.Events():
				switch p := ev.Payload.(type) {
				case *event.SessionStartedPayload:
					if len(p.Resume) > 0 {
						resume = append(json.RawMessage(nil), p.Resume...)
					}
				case *event.ContentDeltaPayload:
					if ev.TurnID == turn && p.Stream == event.StreamText {
						text.WriteString(p.Text)
						if interrupt {
							interrupt = false
							if err := a.InterruptTurn(ctx, "smoke", turn); err != nil {
								t.Fatal(err)
							}
						}
					}
				case *event.ErrorPayload:
					t.Logf("runtime: %s", p.Message)
				case *event.TurnCompletedPayload:
					if ev.TurnID == turn {
						return text.String(), p
					}
				}
			}
		}
	}
	text, result := run("first", "Reply exactly DEVDECK_ANTIGRAVITY_OK. Do not use tools, read files, or change anything.", false)
	if result.Status != "completed" || strings.TrimSpace(text) != "DEVDECK_ANTIGRAVITY_OK" || len(resume) == 0 {
		t.Fatalf("first: text=%q result=%+v cursor=%s", text, result, resume)
	}
	var first cursor
	if err := json.Unmarshal(resume, &first); err != nil {
		t.Fatal(err)
	}
	if err := a.StopSession(ctx, "smoke"); err != nil {
		t.Fatal(err)
	}
	start.ResumeCursor = resume
	if _, err := a.StartSession(ctx, start); err != nil {
		t.Fatal(err)
	}
	text, result = run("second", "What exact marker did you reply with previously? Reply only that marker. Do not use tools or change anything.", false)
	if result.Status != "completed" || strings.TrimSpace(text) != "DEVDECK_ANTIGRAVITY_OK" {
		t.Fatalf("resume: text=%q result=%+v", text, result)
	}
	var second cursor
	_ = json.Unmarshal(resume, &second)
	if second.ConversationID != first.ConversationID {
		t.Fatal("resume switched conversation")
	}
	t.Logf("resume passed; usage first=%+v cumulative=%+v turn=%+v", first.Usage, second.Usage, result.Usage)
	_, result = run("stop", "Print all integers from 1 to 10000, one per line, in your response. Do not use tools or modify files.", true)
	if result.Status != "interrupted" {
		t.Fatalf("stop status=%q", result.Status)
	}
	t.Log("streaming, selected model, Plan, explicit resume and Stop passed")
}

func TestLiveAntigravityImageAndProgress(t *testing.T) {
	if os.Getenv("DEVDECK_AGY_LIVE") != "1" {
		t.Skip("set DEVDECK_AGY_LIVE=1 to use the current agy account")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	a := newAdapter(ctx, "antigravity:live", Config{BinaryName: "agy"}, nil)
	defer a.StopAll(context.Background())
	cwd := t.TempDir()
	if _, err := a.StartSession(ctx, provider.SessionStartInput{ThreadID: "image", Cwd: cwd, Mode: provider.ModeAuto}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("testdata/image.png")
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.SendTurn(ctx, provider.SendTurnInput{
		ThreadID: "image", TurnID: "image-turn",
		Text:        "Inspect the uploaded image. How many colored panels are there, and what are their colors from left to right? Do not run shell commands or modify files.",
		Attachments: []provider.Attachment{{Kind: "image", MIME: "image/png", Name: "panels.png", Data: data}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var text strings.Builder
	var viewed, narratedBeforeTool bool
	for {
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case e := <-a.Events():
			switch p := e.Payload.(type) {
			case *event.ContentDeltaPayload:
				text.WriteString(p.Text)
			case *event.ItemStartedPayload:
				if p.Title == "view_file" {
					viewed = true
					narratedBeforeTool = text.Len() > 0
				}
			case *event.TurnCompletedPayload:
				answer := strings.ToLower(text.String())
				if p.Status != "completed" || !viewed || !narratedBeforeTool || !strings.Contains(answer, "red") || !strings.Contains(answer, "blue") || !strings.Contains(answer, "yellow") {
					t.Fatalf("image/progress failed: status=%s viewed=%v narrated=%v text=%q", p.Status, viewed, narratedBeforeTool, text.String())
				}
				t.Log("uploaded image viewed correctly; progress text arrived before view_file")
				return
			}
		}
	}
}
