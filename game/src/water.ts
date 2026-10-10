import * as THREE from 'three';
import type { LightingState } from './daylight';
import type { RenderQuality } from './render-quality';
import type { WeatherState } from './weather';

/** A single-pass approximation of the sky reflected by a rippling water surface. */
export class WaterSurfaceMaterial extends THREE.MeshStandardMaterial {
  private readonly dayWater = new THREE.Color('#61bdc9');
  private readonly nightWater = new THREE.Color('#183f58');
  private readonly waterUniforms = {
    uWaterTime: { value: 0 },
    uWaterEffects: { value: 1 },
    uWaterDetail: { value: 1 },
    uWaterWind: { value: 0 },
    uWaterAbove: { value: 1 },
    uWaterSky: { value: new THREE.Color('#a8e3f5') },
    uWaterHorizon: { value: new THREE.Color('#e5f3e6') },
    uWaterLightColor: { value: new THREE.Color('#fff3d7') },
    uWaterLightDirection: { value: new THREE.Vector3(0, 0.4, -0.9).normalize() },
    uWaterLightStrength: { value: 1 },
  };

  constructor() {
    super({
      color: '#61bdc9',
      roughness: 0.44,
      metalness: 0,
      transparent: true,
      opacity: 0.56,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // Both faces share the same thin sheet. A second transparent pass wastes
    // fill rate and can make the surface look like a solid wall from below.
    this.forceSinglePass = true;
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.waterUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorldPosition;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vWaterWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWaterWorldPosition;
          uniform float uWaterTime;
          uniform float uWaterEffects;
          uniform float uWaterDetail;
          uniform float uWaterWind;
          uniform float uWaterAbove;
          uniform vec3 uWaterSky;
          uniform vec3 uWaterHorizon;
          uniform vec3 uWaterLightColor;
          uniform vec3 uWaterLightDirection;
          uniform float uWaterLightStrength;
        `)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          // Vertex waves supply the broad swell; analytic derivatives add
          // small moving ripples without normal textures or geometry work.
          vec3 waterNormal = inverseTransformDirection(normal, viewMatrix);
          if (uWaterEffects > 0.5) {
            vec2 waterPoint = vWaterWorldPosition.xz;
            // A slow phase warp breaks up parallel sine-wave stripes while
            // keeping the low setting to one small-scale ripple layer.
            float waterWarp = sin(dot(waterPoint, vec2(0.13, -0.09)) + uWaterTime * 0.21);
            float waterRippleA = cos(dot(waterPoint, vec2(0.73, 0.41)) + uWaterTime * 1.25 + waterWarp * 0.72);
            vec2 waterSlope = vec2(0.061, 0.034) * waterRippleA;
            if (uWaterDetail > 0.5) {
              float waterRippleB = cos(dot(waterPoint, vec2(-1.05, 0.93)) - uWaterTime * 1.7 - waterWarp * 0.91);
              waterSlope += vec2(-0.035, 0.031) * waterRippleB;
            }
            if (uWaterDetail > 1.5) {
              float waterRippleC = cos(dot(waterPoint, vec2(2.45, 1.72)) + uWaterTime * 2.3 + waterWarp * 1.4);
              waterSlope += vec2(0.016, 0.011) * waterRippleC;
            }
            float waterFace = waterNormal.y < 0.0 ? -1.0 : 1.0;
            waterSlope *= 1.0 + uWaterWind * 0.9;
            waterNormal = normalize(waterNormal + vec3(-waterSlope.x, 0.0, -waterSlope.y) * waterFace);
            normal = normalize(mat3(viewMatrix) * waterNormal);
          }
        `)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          // The sky and small solar glints below already model this interface.
          // Subdue the standard material's broad lobe so the same light source
          // does not produce a second, overexposed sheet of reflected glare.
          reflectedLight.directSpecular *= 0.24;
        `)
        .replace('#include <opaque_fragment>', `
          if (uWaterEffects > 0.5) {
            vec3 waterView = normalize(cameraPosition - vWaterWorldPosition);
            float waterFacing = clamp(dot(waterNormal, waterView), 0.0, 1.0);
            float waterFresnel = 0.025 + 0.975 * pow(1.0 - waterFacing, 5.0);
            vec3 waterReflection = reflect(-waterView, waterNormal);
            vec3 waterSky = mix(uWaterHorizon, uWaterSky, smoothstep(0.0, 0.7, abs(waterReflection.y)));
            // Reflection strengthens at grazing angles above the surface.
            // From below, preserve the view of the boat and the illuminated sky.
            float waterReflectionWeight = waterFresnel * mix(0.06, 0.86, uWaterAbove);
            outgoingLight = mix(outgoingLight, waterSky, waterReflectionWeight);
            vec3 waterHalfVector = normalize(waterView + uWaterLightDirection);
            float waterAlignment = max(dot(waterNormal, waterHalfVector), 0.0);
            // Small, interrupted glints replace the broad secondary lobe that
            // made the old reflection look like a painted horizontal stripe.
            vec2 waterGlintPoint = vWaterWorldPosition.xz;
            float waterGlintWarp = sin(dot(waterGlintPoint, vec2(0.13, -0.09)) + uWaterTime * 0.21);
            float waterGlintBreakup = smoothstep(0.12, 0.92, 0.5 + 0.5 * sin(
              dot(waterGlintPoint, vec2(1.6, 0.72)) + uWaterTime * 1.4 + waterGlintWarp * 2.0));
            float waterGlint = pow(waterAlignment, 132.0) * (0.38 + 0.62 * waterGlintBreakup);
            float waterGlintWeight = clamp(waterGlint * uWaterLightStrength * uWaterAbove, 0.0, 0.64);
            // Blend toward the light's color rather than accumulating unbounded
            // glare, so afternoon remains golden and moonlight stays cool silver.
            outgoingLight = mix(outgoingLight, max(outgoingLight, uWaterLightColor * 0.98), waterGlintWeight);
            diffuseColor.a = clamp(diffuseColor.a + waterFresnel * 0.18 * uWaterAbove + waterGlintWeight * 0.045, 0.0, 0.78);
          }
          #include <opaque_fragment>
        `);
    };
  }

  customProgramCacheKey(): string {
    // Quality and time of day change uniforms, never shader programs.
    return 'deepbreath-water-sky-v5';
  }

  setEffectsEnabled(enabled: boolean): void {
    this.waterUniforms.uWaterEffects.value = enabled ? 1 : 0;
  }

  update(time: number, lighting: LightingState, cameraY: number, quality: RenderQuality, weather?: WeatherState): void {
    const uniforms = this.waterUniforms;
    uniforms.uWaterTime.value = time;
    uniforms.uWaterDetail.value = quality.waterDetail;
    uniforms.uWaterWind.value = weather?.wind ?? 0;
    uniforms.uWaterAbove.value = THREE.MathUtils.smoothstep(cameraY, -0.65, 0.9);
    uniforms.uWaterSky.value.setRGB(...lighting.skyColor, THREE.SRGBColorSpace);
    uniforms.uWaterHorizon.value.setRGB(...lighting.horizonColor, THREE.SRGBColorSpace);
    uniforms.uWaterLightColor.value.setRGB(...lighting.lightColor, THREE.SRGBColorSpace);
    // The visible sun/moon, scene lighting and reflection all use the same
    // celestial direction, so the glint follows the disc across the sky.
    uniforms.uWaterLightDirection.value.set(...lighting.direction).normalize();
    uniforms.uWaterLightStrength.value = Math.min(0.82, 0.14 + lighting.sunIntensity * 0.26)
      * (1 - (weather?.cloud ?? 0) * 0.93);
    this.roughness = 0.44 + (weather?.cloud ?? 0) * 0.26;
    this.color.copy(this.dayWater).lerp(this.nightWater, lighting.nightMix);
    this.opacity = THREE.MathUtils.lerp(0.34, 0.56, uniforms.uWaterAbove.value);
  }
}
