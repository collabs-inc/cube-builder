/** The disk revision belongs to the draft's base, never a watcher notification. */
export class FileDraft {
  revision: string | null = null;
  value: string | null = null;
  conflict = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  get canSave() { return !this.conflict; }
  edit(value: string) { this.value = value; }
  read(content: string, revision: string): boolean {
    if (this.pending) return false;
    if (this.value !== null) {
      // A reload may lose the write reply after the server committed it.
      // Matching bytes acknowledge that save without discarding newer edits.
      if (this.value === content) {
        this.value = null;
        this.revision = revision;
        this.conflict = false;
        return true;
      }
      if (this.revision !== revision && this.value !== content) this.conflict = true;
      return false;
    }
    this.revision = revision;
    return true;
  }
  save(value: string, write: (revision: string | null) => Promise<string>): Promise<boolean> {
    this.pending++;
    const task = this.queue.then(async () => {
      if (this.conflict) return false;
      const revision = await write(this.revision);
      this.saved(value, revision);
      return true;
    }).catch(error => { if (error?.code === 'file-changed') this.conflict = true; throw error; }).finally(() => { this.pending--; });
    this.queue = task.catch(() => {});
    return task;
  }
  saved(value: string, revision: string) {
    this.revision = revision;
    if (this.value === value) this.value = null;
  }
}
