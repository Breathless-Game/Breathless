import * as THREE from 'three';
import { Rng } from './rng';
import { RENDER_QUALITY, type RenderQuality } from './render-quality';
import type { WeatherState } from './weather';

const MAX_DROPS = RENDER_QUALITY.high.rainCount;

/** One fixed buffer and one draw call; each streak falls entirely on the GPU. */
export class RainEffect extends THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial> {
  private dropBudget = MAX_DROPS;
  private previousTime = 0;
  private fallBoost = 0;
  private readonly dayColor = new THREE.Color('#bfdae3');
  private readonly nightColor = new THREE.Color('#91b3ca');

  constructor() {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(MAX_DROPS * 2 * 3);
    const streaks = new Float32Array(MAX_DROPS * 2 * 3);
    const rng = new Rng(20261011);
    for (let drop = 0; drop < MAX_DROPS; drop++) {
      const x = rng.range(-42, 42);
      const phase = rng.range(0, 1);
      const z = rng.range(-30, 16);
      const speed = rng.range(11, 19);
      const length = rng.range(0.3, 0.85);
      for (let end = 0; end < 2; end++) {
        const offset = (drop * 2 + end) * 3;
        positions.set([x, phase, z], offset);
        streaks.set([speed, length, end], offset);
      }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aStreak', new THREE.BufferAttribute(streaks, 3));
    geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uFallBoost: { value: 0 },
        uWind: { value: 0 },
        uStorm: { value: 0 },
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color('#bfdae3') },
      },
      vertexShader: `
        attribute vec3 aStreak;
        uniform float uTime;
        uniform float uFallBoost;
        uniform float uWind;
        uniform float uStorm;
        varying float vHeight;
        varying float vDepth;
        varying float vTail;
        void main() {
          float fall = fract(position.y + (uTime * aStreak.x + uFallBoost) / 28.0);
          float tail = aStreak.z * aStreak.y * (1.0 + uStorm * 0.35);
          vec3 drop = vec3(
            mod(position.x + fall * uWind * 8.0 + 42.0, 84.0) - 42.0 - tail * uWind * 0.4,
            27.0 - fall * 28.0 + tail,
            position.z
          );
          vec4 worldPosition = modelMatrix * vec4(drop, 1.0);
          vec4 viewPosition = viewMatrix * worldPosition;
          vHeight = worldPosition.y;
          vDepth = -viewPosition.z;
          vTail = aStreak.z;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vHeight;
        varying float vDepth;
        varying float vTail;
        void main() {
          // Rain belongs to the air, including when viewed through the water.
          if (vHeight <= 0.08) discard;
          float fade = smoothstep(0.08, 0.5, vHeight)
            * (1.0 - smoothstep(22.0, 27.0, vHeight))
            * (1.0 - smoothstep(24.0, 60.0, vDepth));
          gl_FragColor = vec4(uColor, uOpacity * fade * mix(1.0, 0.2, vTail));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    super(geometry, material);
    // The position buffer holds seeds, so its CPU bounds do not represent
    // the animated volume. The small volume follows the camera horizontally.
    this.frustumCulled = false;
    this.renderOrder = 2;
    this.visible = false;
  }

  setQuality(quality: RenderQuality) {
    this.dropBudget = Math.min(MAX_DROPS, Math.max(0, Math.floor(quality.rainCount)));
  }

  update(time: number, weather: WeatherState, cameraY: number, cameraX: number, nightMix: number) {
    // Accumulate acceleration so changing storm strength never multiplies the
    // entire elapsed time and jumps every drop to a new phase. Pauses add zero.
    const elapsed = time - this.previousTime;
    if (elapsed < 0) this.fallBoost = 0;
    else this.fallBoost = (this.fallBoost + elapsed * weather.storm * 7) % 28;
    this.previousTime = time;
    const rain = THREE.MathUtils.clamp(weather.rain, 0, 1);
    const above = THREE.MathUtils.smoothstep(cameraY, 0, 1.2);
    const count = Math.round(this.dropBudget * rain);
    this.visible = count > 0 && above > 0;
    this.geometry.setDrawRange(0, count * 2);
    if (!this.visible) return;
    this.position.x = cameraX;
    const uniforms = this.material.uniforms;
    uniforms.uTime.value = time;
    uniforms.uFallBoost.value = this.fallBoost;
    uniforms.uWind.value = weather.wind;
    uniforms.uStorm.value = weather.storm;
    uniforms.uOpacity.value = (0.25 + rain * 0.14) * above;
    uniforms.uColor.value.copy(this.dayColor).lerp(this.nightColor, nightMix);
  }
}
