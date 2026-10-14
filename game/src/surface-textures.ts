import * as THREE from 'three';
import type { RenderQuality } from './render-quality';

/** World-space procedural detail needs no UV seams or downloaded image assets. */
export class SurfaceTextures {
  readonly uniforms = { uSurfaceTextures: { value: 0 } };

  setQuality(quality: RenderQuality): void {
    this.uniforms.uSurfaceTextures.value = quality.waterDetail === 2 ? 1 : 0;
  }

  material(kind: 'rock' | 'sand', colour: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) {
    const material = new THREE.MeshStandardMaterial({ color: colour, flatShading: true, roughness: 0.9, ...extra });
    material.userData.surfaceTexture = kind;
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        varying vec3 vSurfaceTexturePosition;
      `).replace('#include <project_vertex>', `#include <project_vertex>
        vec4 texturePosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          texturePosition = instanceMatrix * texturePosition;
        #endif
        vSurfaceTexturePosition = (modelMatrix * texturePosition).xyz;
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        uniform float uSurfaceTextures;
        varying vec3 vSurfaceTexturePosition;
        float surfaceHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float surfaceNoise(vec2 p) {
          vec2 cell = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(surfaceHash(cell), surfaceHash(cell + vec2(1.0, 0.0)), f.x),
            mix(surfaceHash(cell + vec2(0.0, 1.0)), surfaceHash(cell + vec2(1.0, 1.0)), f.x), f.y);
        }
      `).replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (uSurfaceTextures > 0.5) {
          vec3 p = vSurfaceTexturePosition;
          // Texture frequencies disappear before they become sub-pixel noise.
          float textureFade = 1.0 - smoothstep(0.05, 0.24, length(fwidth(p)));
          float grain = surfaceNoise((p.xz + p.y * vec2(0.37, 0.61)) * 12.0) - 0.5;
          ${kind === 'rock' ? `
            float strata = sin(p.y * 3.2 + surfaceNoise(p.xz * 0.65) * 2.5);
            float weathering = surfaceNoise(p.xz * 1.8 + p.y * 0.4) - 0.5;
            diffuseColor.rgb *= 1.0 + textureFade * (grain * 0.16 + strata * 0.045 + weathering * 0.08);
          ` : `
            float ripple = sin(p.x * 7.0 + p.z * 2.8 + surfaceNoise(p.xz * 0.3) * 2.0);
            diffuseColor.rgb *= 1.0 + textureFade * (grain * 0.12 + ripple * 0.05);
          `}
          roughnessFactor = clamp(roughnessFactor + grain * textureFade * 0.12, 0.65, 1.0);
        }
      `);
    };
    material.customProgramCacheKey = () => `surface-texture-${kind}-v1`;
    return material;
  }
}
