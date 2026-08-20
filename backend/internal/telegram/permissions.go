package telegram

import (
	"context"
	"encoding/json"
	"log"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/domain"
)

// /permissions — the runtime mode, which is the same control the app's
// composer labels "Approval required".
//
// It belongs in Telegram because that is where the operator is when it bites:
// an approval card arrives for every command, on a phone, and the only way to
// stop being asked was to walk to the desk and change it in the app.
//
// Unlike /agents, this DOES apply to the running session. The mode is thread
// state the engine already accepts a command for (CmdThreadRuntimeModeSet),
// not something fixed at creation, so there is no reason to defer it.

// permissionOption mirrors PERMISSION_OPTIONS in ComposerControls.tsx. Kept
// in the same order and with the same meanings so an operator switching
// between the app and Telegram sees one setting, not two.
type permissionOption struct {
	Mode  provider.RuntimeMode
	Label string
}

var permissionOptions = []permissionOption{
	{provider.ModeApprovalRequired, "🔒 Approval required — tanya dulu"},
	{provider.ModeAutoAcceptEdits, "✏️ Auto-accept edits — edit langsung, lainnya tanya"},
	{provider.ModeAuto, "✨ Auto — rutin jalan, sisanya tanya"},
	{provider.ModeFullAccess, "🔓 Full access — tanpa konfirmasi"},
}

// currentMode reports the thread's live runtime mode. Read from the engine
// rather than stored on the binding: the app changes this too, and a copy
// here would drift the moment it did.
func (b *Bridge) currentMode(threadID string) provider.RuntimeMode {
	if thread, ok := b.engine.State().Thread(threadID); ok && thread.Mode != "" {
		return thread.Mode
	}
	return provider.ModeApprovalRequired
}

func (b *Bridge) cmdPermissions(ctx context.Context, m *Message, binding domain.TelegramBinding) {
	active := b.currentMode(binding.ThreadID)

	kb := make(InlineKeyboard, 0, len(permissionOptions))
	for _, opt := range permissionOptions {
		label := opt.Label
		if opt.Mode == active {
			// Marked rather than omitted: an operator opening this needs to
			// know what it is set to now, which is the question that sent
			// them here in the first place.
			label = "✅ " + label
		}
		kb = append(kb, []InlineButton{{
			Text:         label,
			CallbackData: b.mintCallback(callbackTarget{Kind: cbPermission, ThreadID: binding.ThreadID, Mode: opt.Mode}),
		}})
	}

	if err := b.callWithRetry(ctx, func() error {
		_, err := b.client.SendMessage(ctx, SendOptions{
			ChatID: m.Chat.ID, TopicID: m.MessageThreadID,
			Text:     EscapeMarkdownV2("permission sesi ini (berlaku langsung):"),
			Keyboard: kb,
		})
		return err
	}); err != nil {
		log.Printf("telegram: send permission picker thread %s: %v", binding.ThreadID, err)
	}
}

// handlePermissionSelection applies the tapped mode to the live thread.
func (b *Bridge) handlePermissionSelection(ctx context.Context, cq *CallbackQuery, target callbackTarget) {
	payload, err := json.Marshal(orchestration.RuntimeModeSetPayload{Mode: target.Mode})
	if err != nil {
		log.Printf("telegram: marshal runtime mode: %v", err)
		b.answerCallback(ctx, cq.ID, "gagal menyimpan permission")
		return
	}
	if _, err := b.dispatch(ctx, orchestration.Command{
		Type: orchestration.CmdThreadRuntimeModeSet, ThreadID: target.ThreadID, Payload: payload,
	}); err != nil {
		log.Printf("telegram: set runtime mode thread %s: %v", target.ThreadID, err)
		b.answerCallback(ctx, cq.ID, "gagal menyimpan permission")
		return
	}
	b.forgetCallback(cq.Data)
	b.answerCallback(ctx, cq.ID, "")
	b.editCallbackMessage(ctx, cq.Message, EscapeMarkdownV2("permission: "+permissionLabel(target.Mode)))
}

func permissionLabel(mode provider.RuntimeMode) string {
	for _, opt := range permissionOptions {
		if opt.Mode == mode {
			return opt.Label
		}
	}
	return string(mode)
}
