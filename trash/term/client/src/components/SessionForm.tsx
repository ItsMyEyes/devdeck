import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getLastCwd, setLastCwd } from '@/lib/storage';

interface SessionFormProps {
  onStart: (cwd: string) => void;
  errorMessage: string | null;
}

export function SessionForm({ onStart, errorMessage }: SessionFormProps) {
  const [cwd, setCwd] = useState(() => getLastCwd());

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = cwd.trim();
    if (!trimmed) return;
    setLastCwd(trimmed);
    onStart(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 max-w-md mx-auto mt-24">
      <label htmlFor="cwd" className="text-sm font-medium">
        Working directory
      </label>
      <Input
        id="cwd"
        value={cwd}
        onChange={(event) => setCwd(event.target.value)}
        placeholder="C:\path\to\project"
      />
      {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}
      <Button type="submit">Start session</Button>
    </form>
  );
}
