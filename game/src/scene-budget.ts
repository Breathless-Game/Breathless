import * as THREE from 'three';

/** Coarse model visibility, including a second camera while a map preview is open. */
export class ViewVisibility {
  private main = new THREE.Frustum();
  private preview = new THREE.Frustum();
  private matrix = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private hasPreview = false;

  private prepare(view: THREE.Camera, frustum: THREE.Frustum): void {
    view.updateMatrixWorld();
    frustum.setFromProjectionMatrix(this.matrix.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
  }

  update(camera: THREE.Camera, preview?: THREE.Camera): void {
    this.prepare(camera, this.main);
    this.hasPreview = !!preview;
    if (preview) this.prepare(preview, this.preview);
  }

  intersects(position: THREE.Vector3, radius: number): boolean {
    this.sphere.center.copy(position);
    // A generous margin keeps deformed fins and camera shake clear of the culling edge.
    this.sphere.radius = radius + 2;
    return this.main.intersectsSphere(this.sphere) || (this.hasPreview && this.preview.intersectsSphere(this.sphere));
  }
}

/** One cached preview frame; no timer, queue or retained map scenes. */
export class PreviewFrameCache {
  private last = -Infinity;
  private width = 0;
  private height = 0;
  private detail = 0;

  needsFrame(now: number, width: number, height: number, detail: 1 | 2 | 3, force = false): boolean {
    if (!force && width === this.width && height === this.height && detail === this.detail
      && now >= this.last && now - this.last < 1000 / [10, 15, 20][detail - 1]) return false;
    this.last = now;
    this.width = width;
    this.height = height;
    this.detail = detail;
    return true;
  }

  invalidate(): void { this.last = -Infinity; }
}

/** Match the main view's aspect without rendering a full-screen image for a small chart card. */
export function previewSize(width: number, height: number, detail: 1 | 2 | 3): [number, number] {
  const scale = Math.min(1, [480, 640, 960][detail - 1] / Math.max(1, width), 720 / Math.max(1, height));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}
