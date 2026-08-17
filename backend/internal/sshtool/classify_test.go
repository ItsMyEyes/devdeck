package sshtool

import "testing"

func TestClassifyReadOnlyCommands(t *testing.T) {
	for _, cmd := range []string{
		"ls -la /etc",
		"cat /etc/nginx/nginx.conf",
		"tail -n 200 /var/log/syslog",
		"journalctl -u nginx --since '1 hour ago'",
		"systemctl status nginx",
		"docker ps -a",
		"docker logs web --tail 50",
		"kubectl get pods -A",
		"git status",
		"df -h | grep /dev",
		"ps aux | grep node | wc -l",
	} {
		if got := Classify(cmd); got != ClassRead {
			t.Errorf("Classify(%q) = %q, want %q", cmd, got, ClassRead)
		}
	}
}

func TestClassifyMutatingCommands(t *testing.T) {
	for _, cmd := range []string{
		"systemctl restart nginx",
		"sudo systemctl status nginx", // sudo is always privileged
		"rm -rf /tmp/build",
		"docker compose up -d",
		"kubectl delete pod web",
		"git checkout main",
		"echo hi > /etc/motd",
		"cat /etc/passwd >> /tmp/leak",
		"ls $(rm -rf /tmp/x)",
		"tail -f /var/log/app.log && systemctl restart app",
		"curl https://example.com -o /tmp/x",
		"somethingnobodyknows --flag",
		"",
	} {
		if got := Classify(cmd); got != ClassMutate {
			t.Errorf("Classify(%q) = %q, want %q", cmd, got, ClassMutate)
		}
	}
}
