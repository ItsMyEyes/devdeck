export class RingBuffer {
  private chunks: string[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(data: string): void {
    this.chunks.push(data);
    this.totalBytes += Buffer.byteLength(data, 'utf8');

    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed !== undefined) {
        this.totalBytes -= Buffer.byteLength(removed, 'utf8');
      }
    }
  }

  contents(): string {
    return this.chunks.join('');
  }
}
