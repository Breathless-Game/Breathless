import * as THREE from 'three';

/** Quintic fade: both ends meet clear water or solid haze without a visible slope change. */
export function hazeFade(value: number, near: number, far: number): number {
  const t = THREE.MathUtils.clamp((value - near) / Math.max(1e-6, far - near), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Open-water visibility changes continuously with depth; only an actual ocean trench eases out. */
export function underwaterHazeRange(depth: number, shelfDepth: number, hasTrench: boolean): [number, number] {
  const d = Math.max(0, depth);
  const deep = hazeFade(d, 0, 160);
  const near = THREE.MathUtils.lerp(12, 9, deep);
  const openFar = THREE.MathUtils.lerp(78, 46, deep);
  const trench = hasTrench ? hazeFade(d, shelfDepth, shelfDepth + 16) : 0;
  return [near, THREE.MathUtils.lerp(openFar, Math.max(openFar, 54), trench)];
}

/** Blend into the water beyond the playable corridor, before geometry ends. */
export function boundaryHaze(x: number, start: number, end: number): number {
  return hazeFade(Math.abs(x), start, end);
}

const FADE_GLSL = `
  float waterHazeFade(float value, float start, float end) {
    float t = clamp((value - start) / max(0.000001, end - start), 0.0, 1.0);
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  }
`;

/** Reuse material fog in one render pass; distant silhouettes and lateral edges dissolve together. */
export class UnderwaterHaze {
  private readonly attached = new WeakSet<THREE.Material>();
  readonly uniforms = {
    uUnderwaterHaze: { value: 0 },
    uWaterHazeNear: { value: 12 },
    uWaterHazeFar: { value: 78 },
    uWaterEdgeStart: { value: 208 },
    uWaterEdgeEnd: { value: 264 },
  };

  apply(root: THREE.Object3D): void {
    root.traverse(object => {
      const material = (object as THREE.Mesh).material;
      if (!material) return;
      for (const item of Array.isArray(material) ? material : [material]) {
        if (item instanceof THREE.ShaderMaterial || (item as THREE.Material & { fog?: boolean }).fog === false || this.attached.has(item)) continue;
        this.attached.add(item);
        const compile = item.onBeforeCompile;
        const cacheKey = item.customProgramCacheKey();
        item.onBeforeCompile = (shader, renderer) => {
          compile.call(item, shader, renderer);
          Object.assign(shader.uniforms, this.uniforms);
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
              varying vec3 vWaterHazeView;
              varying vec3 vWaterHazeWorld;
            `)
            .replace('#include <project_vertex>', `#include <project_vertex>
              vWaterHazeView = mvPosition.xyz;
              vec4 hazePosition = vec4(transformed, 1.0);
              #ifdef USE_BATCHING
                hazePosition = batchingMatrix * hazePosition;
              #endif
              #ifdef USE_INSTANCING
                hazePosition = instanceMatrix * hazePosition;
              #endif
              vWaterHazeWorld = (modelMatrix * hazePosition).xyz;
            `);
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
              varying vec3 vWaterHazeView;
              varying vec3 vWaterHazeWorld;
              uniform float uUnderwaterHaze;
              uniform float uWaterHazeNear;
              uniform float uWaterHazeFar;
              uniform float uWaterEdgeStart;
              uniform float uWaterEdgeEnd;
              ${FADE_GLSL}
            `)
            .replace('#include <fog_fragment>', `
              #ifdef USE_FOG
                #ifdef FOG_EXP2
                  float baseFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
                #else
                  float baseFog = smoothstep(fogNear, fogFar, vFogDepth);
                #endif
                float waterFog = waterHazeFade(length(vWaterHazeView), uWaterHazeNear, uWaterHazeFar);
                float edgeFog = waterHazeFade(abs(vWaterHazeWorld.x), uWaterEdgeStart, uWaterEdgeEnd);
                float submerged = smoothstep(0.0, 2.0, -vWaterHazeWorld.y);
                float waterBlend = 1.0 - (1.0 - waterFog) * (1.0 - edgeFog);
                float fogFactor = mix(baseFog, waterBlend, uUnderwaterHaze * submerged);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
              #endif
            `);
        };
        item.customProgramCacheKey = () => `${cacheKey}|underwater-haze-v1`;
        item.needsUpdate = true;
      }
    });
  }

  update(depth: number, shelfDepth: number, hasTrench: boolean): void {
    const [near, far] = underwaterHazeRange(depth, shelfDepth, hasTrench);
    this.uniforms.uUnderwaterHaze.value = hazeFade(depth, 0, 3);
    this.uniforms.uWaterHazeNear.value = near;
    this.uniforms.uWaterHazeFar.value = far;
  }
}
