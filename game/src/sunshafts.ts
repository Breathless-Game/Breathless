import * as THREE from 'three';
import type { LightingState } from './daylight';
import { RENDER_QUALITY, type RenderQuality } from './render-quality';
import type { WeatherState } from './weather';

/** Sparse, depth-attenuated scattering, batched into one transparent draw. */
export class SunShafts {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms = {
    uShaftTime: { value: 0 },
    uShaftStrength: { value: 0 },
    uShaftDrift: { value: 0 },
    uShaftColor: { value: new THREE.Color('#fff0d1') },
  };

  constructor() {
    // The first four openings cover the whole scene; higher settings fill in
    // the gaps without allocating more meshes, materials or render passes.
    const openings = [-48, -16, 16, 48, -64, -32, 0, 32, 64, -56, -24, 8, 40, 56];
    const plane = new THREE.PlaneGeometry(2, 1, 1, 8);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = plane.index;
    this.geometry.attributes = plane.attributes;
    const beams = new Float32Array(openings.length * 4);
    for (let i = 0; i < openings.length; i++) {
      // x, z, penetration depth, aperture width. Deterministic variation keeps
      // the light from looking like regularly spaced stage spotlights.
      const phase = i * 2.39996;
      beams.set([
        openings[i] + Math.sin(phase) * 2.6,
        -8 - (i * 7 % 11),
        25 + Math.sin(phase + 1) * 6,
        0.9 + (Math.sin(phase + 2) + 1) * 0.5,
      ], i * 4);
    }
    this.geometry.setAttribute('aShaft', new THREE.InstancedBufferAttribute(beams, 4));
    this.geometry.instanceCount = RENDER_QUALITY.high.rayCount;
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute vec4 aShaft;
        uniform float uShaftTime;
        uniform float uShaftDrift;
        varying vec2 vShaftUv;
        varying float vShaftDepth;
        varying float vShaftSeed;
        varying vec3 vShaftPosition;
        void main() {
          vShaftUv = uv;
          vShaftDepth = (1.0 - uv.y) * aShaft.z;
          vShaftSeed = aShaft.x * 0.73;
          float aperture = aShaft.w * (0.42 + vShaftDepth * 0.095);
          // Small refractive meanders, not whole rigid planes rotating about
          // their centres. The entrance stays at the moving water surface.
          float meander = sin(vShaftDepth * 0.16 + vShaftSeed + uShaftTime * 0.31)
            * vShaftDepth * 0.018;
          vec3 shaft = vec3(
            aShaft.x + position.x * aperture + uShaftDrift * vShaftDepth + meander,
            -0.12 - vShaftDepth,
            aShaft.y
          );
          vec4 worldPosition = modelMatrix * vec4(shaft, 1.0);
          vShaftPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform float uShaftTime;
        uniform float uShaftStrength;
        uniform float uShaftDrift;
        uniform vec3 uShaftColor;
        varying vec2 vShaftUv;
        varying float vShaftDepth;
        varying float vShaftSeed;
        varying vec3 vShaftPosition;
        void main() {
          float across = vShaftUv.x * 2.0 - 1.0;
          // A Gaussian cross-section has no visible plane edge. A soft
          // entrance and terminus also remove the old rectangular cut-offs.
          float profile = exp(-across * across * 5.6)
            * (1.0 - smoothstep(0.65, 1.0, abs(across)));
          float entrance = smoothstep(0.0, 1.7, vShaftDepth);
          float terminus = smoothstep(0.0, 0.22, vShaftUv.y);
          float attenuation = exp(-vShaftDepth * 0.095);
          float shimmer = 0.8 + 0.12 * sin(uShaftTime * 0.65 + vShaftSeed + vShaftDepth * 0.23)
            + 0.08 * sin(uShaftTime * 0.37 - vShaftSeed * 1.7 + across * 5.0);
          vec3 viewDirection = normalize(cameraPosition - vShaftPosition);
          vec3 propagation = normalize(vec3(uShaftDrift, -1.0, 0.0));
          float viewScattering = 0.7 + 0.3 * pow(max(dot(viewDirection, propagation), 0.0), 2.0);
          float alpha = uShaftStrength * profile * entrance * terminus * attenuation * shimmer * viewScattering;
          // Red wavelengths disappear faster as sunlight penetrates water.
          vec3 transmittedColor = uShaftColor * exp(-vShaftDepth * vec3(0.032, 0.014, 0.004));
          gl_FragColor = vec4(transmittedColor, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.material.forceSinglePass = true;
    const mesh = new THREE.Mesh(this.geometry, this.material);
    // Vertex positions are procedural and exceed the small source plane.
    mesh.frustumCulled = false;
    this.group.name = 'Sunlight scattering';
    this.group.add(mesh);
    this.group.visible = false;
  }

  setQuality(quality: RenderQuality): void {
    this.geometry.instanceCount = Math.min(14, Math.max(0, quality.rayCount));
  }

  update(time: number, lighting: LightingState, weather: WeatherState, cameraY: number, enabled: boolean): void {
    const transmission = Math.pow(1 - weather.cloud, 2) * (1 - weather.rain * 0.65);
    const depthFade = 1 - THREE.MathUtils.smoothstep(-cameraY, 24, 38);
    const sunElevation = Math.max(0, lighting.sunDirection[1]);
    const horizonFade = THREE.MathUtils.smoothstep(sunElevation, 0, 0.12);
    const strength = 0.16 * lighting.daylight * transmission * depthFade * horizonFade;
    this.group.visible = enabled && strength > 0.001 && this.geometry.instanceCount > 0;
    if (!this.group.visible) return;
    this.uniforms.uShaftTime.value = time;
    this.uniforms.uShaftStrength.value = strength;
    this.uniforms.uShaftColor.value.setRGB(...lighting.lightColor, THREE.SRGBColorSpace);
    // Refraction bends incoming rays toward the vertical. Limiting this
    // projected slope keeps low sun from producing horizontal light slabs.
    this.uniforms.uShaftDrift.value = -lighting.sunDirection[0] * 0.55;
  }
}
