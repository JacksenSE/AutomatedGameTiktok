/**
 * Generic object pool for reusing instances to avoid GC pressure.
 * Uses a free-list approach for O(1) acquire/release.
 */
export class ObjectPool<T> {
  private available: T[] = [];
  private createFn: () => T;
  private resetFn: (obj: T) => void;
  private destroyFn?: (obj: T) => void;

  constructor(
    createFn: () => T,
    resetFn: (obj: T) => void,
    destroyFn?: (obj: T) => void,
    initialSize = 0
  ) {
    this.createFn = createFn;
    this.resetFn = resetFn;
    this.destroyFn = destroyFn;
    
    // Pre-populate pool
    for (let i = 0; i < initialSize; i++) {
      this.available.push(this.createFn());
    }
  }

  acquire(): T {
    let obj = this.available.pop();
    if (!obj) {
      obj = this.createFn();
    }
    this.resetFn(obj);
    return obj;
  }

  release(obj: T): void {
    this.available.push(obj);
  }

  clear(): void {
    if (this.destroyFn) {
      for (const obj of this.available) {
        this.destroyFn(obj);
      }
    }
    this.available.length = 0;
  }

  get poolSize(): number {
    return this.available.length;
  }
}