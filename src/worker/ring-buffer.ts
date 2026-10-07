// Adapted from src/main/sidecar/ring-buffer.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Fixed-capacity circular byte buffer. Oldest data is silently
 * overwritten when the buffer is full. Snapshot returns a copy
 * of the live contents in write order.
 */
export class RingBuffer {
  private buf: Buffer;
  private head = 0; // next write position
  private filled = 0; // bytes currently stored (up to capacity)
  private total = 0; // lifetime bytes written

  constructor(private capacity: number) {
    this.buf = Buffer.alloc(capacity);
  }

  get bytesWritten(): number {
    return this.total;
  }

  write(data: Uint8Array): void {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const len = chunk.length;
    this.total += len;

    if (len >= this.capacity) {
      // Data larger than buffer — keep only the tail
      chunk.copy(this.buf, 0, len - this.capacity, len);
      this.head = 0;
      this.filled = this.capacity;
      return;
    }

    const spaceToEnd = this.capacity - this.head;

    if (len <= spaceToEnd) {
      chunk.copy(this.buf, this.head);
    } else {
      chunk.copy(this.buf, this.head, 0, spaceToEnd);
      chunk.copy(this.buf, 0, spaceToEnd);
    }

    this.head = (this.head + len) % this.capacity;
    this.filled = Math.min(this.filled + len, this.capacity);
  }

  /** Return a copy of buffered data in write order. */
  snapshot(): Buffer {
    if (this.filled === 0) return Buffer.alloc(0);

    if (this.filled < this.capacity) {
      // Haven't wrapped yet — data starts at 0
      return Buffer.from(this.buf.subarray(0, this.filled));
    }

    // Wrapped: oldest data starts at head, newest ends just before head
    const result = Buffer.alloc(this.capacity);
    const tailLen = this.capacity - this.head;
    this.buf.copy(result, 0, this.head, this.head + tailLen);
    this.buf.copy(result, tailLen, 0, this.head);
    return result;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
  }

  /** Release unused capacity after exit without moving the absolute cursor. */
  compact(capacity: number): void {
    const tail = this.snapshot().subarray(-capacity);
    this.buf = Buffer.alloc(capacity);
    tail.copy(this.buf);
    this.capacity = capacity;
    this.filled = tail.length;
    this.head = tail.length % capacity;
  }

  /**
   * Returns the bytes written after `seq`. When `seq` predates the oldest
   * byte still buffered (or is impossibly far ahead), the caller cannot be
   * brought up to date incrementally: `reset` is true and `data` is the
   * whole snapshot, which the caller must render after clearing.
   */
  readSince(seq: number): { data: Buffer; seq: number; reset: boolean } {
    const oldest = this.total - this.filled;
    if (seq < oldest || seq > this.total) {
      return { data: this.snapshot(), seq: this.total, reset: true };
    }
    return {
      data: Buffer.from(this.snapshot().subarray(seq - oldest)),
      seq: this.total,
      reset: false,
    };
  }
}
