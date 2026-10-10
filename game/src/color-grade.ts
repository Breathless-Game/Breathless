import * as THREE from 'three';
import type { LightingState } from './daylight';
import type { WeatherState } from './weather';

/** Shared color balance in existing material shaders; no fullscreen render pass. */
export class SceneColorGrade {
  private readonly attached = new WeakSet<THREE.Material>();
  readonly uniforms = {
    uGradeShadows: { value: new THREE.Vector3(1, 1, 1) },
    uGradeHighlights: { value: new THREE.Vector3(1, 1, 1) },
    uGradeSaturation: { value: 1 },
  };

  apply(root: THREE.Object3D): void {
    root.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (!material) return;
      for (const item of Array.isArray(material) ? material : [material]) {
        // Atmospheric shaders already carry their own time-dependent colors.
        if (item instanceof THREE.ShaderMaterial || this.attached.has(item)) continue;
        this.attached.add(item);
        const compile = item.onBeforeCompile;
        const cacheKey = item.customProgramCacheKey();
        item.onBeforeCompile = (shader, renderer) => {
          compile.call(item, shader, renderer);
          Object.assign(shader.uniforms, this.uniforms);
          shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
            uniform vec3 uGradeShadows;
            uniform vec3 uGradeHighlights;
            uniform float uGradeSaturation;
          `).replace('#include <colorspace_fragment>', `
            float gradeLuma = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            vec3 gradeBalance = mix(uGradeShadows, uGradeHighlights, smoothstep(0.015, 0.65, gradeLuma));
            gl_FragColor.rgb = max(vec3(0.0), mix(vec3(gradeLuma), gl_FragColor.rgb, uGradeSaturation) * gradeBalance);
            #include <colorspace_fragment>
          `);
        };
        item.customProgramCacheKey = () => `${cacheKey}|day-color-grade-v1`;
        item.needsUpdate = true;
      }
    });
  }

  update(lighting: LightingState, weather: WeatherState, cameraY: number, enabled: boolean): void {
    const uniforms = this.uniforms;
    if (!enabled) {
      uniforms.uGradeShadows.value.set(1, 1, 1);
      uniforms.uGradeHighlights.value.set(1, 1, 1);
      uniforms.uGradeSaturation.value = 1;
      return;
    }
    const night = lighting.nightMix;
    const afternoon = THREE.MathUtils.smoothstep(lighting.hour, 11, 17);
    const warmth = (0.07 + afternoon * 0.1) * (1 - night) * (1 - weather.cloud * 0.8)
      * Math.exp(-Math.max(0, -cameraY) / 18);
    // Warm highlights and cooler shadows retain material colors; at depth,
    // red light disappears and the warm cast gives way to a cool blue fill.
    uniforms.uGradeHighlights.value.set(1 + warmth - night * 0.13, 1 - warmth * 0.1, 1 - warmth + night * 0.13);
    uniforms.uGradeShadows.value.set(0.94 - night * 0.13, 0.99 - night * 0.03, 1.04 + night * 0.07);
    uniforms.uGradeSaturation.value = 1 - night * 0.17 - weather.cloud * 0.12;
  }
}
