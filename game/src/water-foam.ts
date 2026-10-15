import * as THREE from 'three';

/** Calm lakes stay quiet; ocean whitecaps grow with the actual swell amplitude. */
export function whitecapStrength(waves: number, wind: number): number {
  return THREE.MathUtils.clamp((waves * (1 + wind * 0.75) - 0.75) / 1.35, 0, 1);
}

/** Foam spreads while its opacity rises and then dissolves, rather than shrinking into a dot. */
export function foamEnvelope(age: number, life: number): number {
  const t = age / Math.max(0.01, life);
  return THREE.MathUtils.smoothstep(t, 0, 0.12) * (1 - THREE.MathUtils.smoothstep(t, 0.35, 1));
}

/** A low-poly surface patch with soft, broken edges; one opacity value per instance. */
export function foamGeometry(opacity: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.CircleGeometry(1, 9);
  geometry.rotateX(-Math.PI / 2);
  geometry.setAttribute('aFoamOpacity', new THREE.InstancedBufferAttribute(opacity, 1).setUsage(THREE.DynamicDrawUsage));
  return geometry;
}

export class FoamSurfaceMaterial extends THREE.MeshStandardMaterial {
  constructor() {
    super({ color: '#e6f3ef', emissive: '#b2ccc9', emissiveIntensity: 0.22,
      roughness: 1, transparent: true, opacity: 0.82, depthWrite: false,
      side: THREE.DoubleSide, flatShading: true });
    this.forceSinglePass = true;
    this.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aFoamOpacity;
          varying float vFoamOpacity;
          varying vec2 vFoamUV;
        `)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vFoamOpacity = aFoamOpacity;
          vFoamUV = uv * 2.0 - 1.0;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vFoamOpacity;
          varying vec2 vFoamUV;
        `)
        .replace('#include <alphatest_fragment>', `
          float foamRim = 1.0 - smoothstep(0.55, 1.0, length(vFoamUV));
          float foamLace = sin(vFoamUV.x * 17.0 + sin(vFoamUV.y * 9.0)) * cos(vFoamUV.y * 14.0);
          float foamAA = max(fwidth(foamLace), 0.03);
          float foamBreak = mix(0.18, 1.0, smoothstep(-0.15 - foamAA, 0.25 + foamAA, foamLace));
          diffuseColor.a *= foamRim * foamBreak * vFoamOpacity;
          #include <alphatest_fragment>
        `);
    };
  }

  customProgramCacheKey(): string { return 'deepbreath-surface-foam-v1'; }
}
