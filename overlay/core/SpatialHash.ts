/**
 * Fixed-grid spatial hash for O(1) neighbor queries.
 * Critical for AI and collision detection with thousands of entities.
 */
export interface SpatialEntity {
  id: string;
  x: number;
  y: number;
}

export class SpatialHash<T extends SpatialEntity> {
  private cellSize: number;
  private grid = new Map<string, T[]>();
  private entityToCell = new Map<string, string>();
  
  // Reusable arrays to avoid allocations
  private tempResults: T[] = [];
  private tempCells: string[] = [];

  constructor(cellSize = 64) {
    this.cellSize = cellSize;
  }

  private getCellKey(x: number, y: number): string {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return `${cx},${cy}`;
  }

  insert(entity: T): void {
    const cellKey = this.getCellKey(entity.x, entity.y);
    const oldCell = this.entityToCell.get(entity.id);
    
    // Remove from old cell if exists
    if (oldCell && oldCell !== cellKey) {
      const oldList = this.grid.get(oldCell);
      if (oldList) {
        const idx = oldList.findIndex(e => e.id === entity.id);
        if (idx >= 0) oldList.splice(idx, 1);
        if (oldList.length === 0) this.grid.delete(oldCell);
      }
    }
    
    // Add to new cell
    if (!oldCell || oldCell !== cellKey) {
      let list = this.grid.get(cellKey);
      if (!list) {
        list = [];
        this.grid.set(cellKey, list);
      }
      list.push(entity);
      this.entityToCell.set(entity.id, cellKey);
    }
  }

  remove(entity: T): void {
    const cellKey = this.entityToCell.get(entity.id);
    if (!cellKey) return;
    
    const list = this.grid.get(cellKey);
    if (list) {
      const idx = list.findIndex(e => e.id === entity.id);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.grid.delete(cellKey);
    }
    this.entityToCell.delete(entity.id);
  }

  queryRadius(x: number, y: number, radius: number): T[] {
    this.tempResults.length = 0;
    this.tempCells.length = 0;
    
    const radiusSq = radius * radius;
    const cellRadius = Math.ceil(radius / this.cellSize);
    const centerCx = Math.floor(x / this.cellSize);
    const centerCy = Math.floor(y / this.cellSize);
    
    // Collect relevant cells
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        this.tempCells.push(`${centerCx + dx},${centerCy + dy}`);
      }
    }
    
    // Check entities in those cells
    for (let i = 0; i < this.tempCells.length; i++) {
      const list = this.grid.get(this.tempCells[i]);
      if (!list) continue;
      
      for (let j = 0; j < list.length; j++) {
        const entity = list[j];
        const dx = entity.x - x;
        const dy = entity.y - y;
        if (dx * dx + dy * dy <= radiusSq) {
          this.tempResults.push(entity);
        }
      }
    }
    
    return this.tempResults;
  }

  clear(): void {
    this.grid.clear();
    this.entityToCell.clear();
  }
}