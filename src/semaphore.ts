/** 计数信号量：限制同时运行的 claude 会话数（执行机 CPU/内存与 API 限流的闸门） */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}
