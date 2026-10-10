import * as THREE from 'three';
import type { LightingState } from './daylight';
import type { RenderQuality } from './render-quality';

/** A single-pass approximation of the sky reflected by a rippling water surface. */
export class WaterSurfaceMaterial extends THREE.MeshStandardMaterial {
  private readonly dayWater = new THREE.Color('#61bdc9');
  private readonly nightWater = new THREE.Color('#183f58');
  private readonly waterUniforms = {
    uWaterTime: { value: 0 },
    uWaterDetail: { value: 1 },
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
      roughness: 0.38,
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
          uniform float uWaterDetail;
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
          vec2 waterPoint = vWaterWorldPosition.xz;
          float waterRippleA = cos(dot(waterPoint, vec2(0.68, 0.36)) + uWaterTime * 1.4);
          vec2 waterSlope = vec2(0.085, 0.045) * waterRippleA;
          if (uWaterDetail > 0.5) {
            float waterRippleB = cos(dot(waterPoint, vec2(-1.05, 0.93)) - uWaterTime * 1.9);
            waterSlope += vec2(-0.042, 0.037) * waterRippleB;
          }
          if (uWaterDetail > 1.5) {
            float waterRippleC = cos(dot(waterPoint, vec2(2.45, 1.72)) + uWaterTime * 2.6);
            waterSlope += vec2(0.018, 0.013) * waterRippleC;
          }
          vec3 waterNormal = inverseTransformDirection(normal, viewMatrix);
          float waterFace = waterNormal.y < 0.0 ? -1.0 : 1.0;
          waterNormal = normalize(waterNormal + vec3(-waterSlope.x, 0.0, -waterSlope.y) * waterFace);
          normal = normalize(mat3(viewMatrix) * waterNormal);
        `)
        .replace('#include <opaque_fragment>', `
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
          float waterGlint = pow(waterAlignment, 96.0);
          if (uWaterDetail > 0.5) waterGlint += 0.18 * pow(waterAlignment, 28.0);
          float waterGlintWeight = clamp(waterGlint * uWaterLightStrength * uWaterAbove, 0.0, 0.88);
          // Blend toward the light's color rather than accumulating unbounded
          // glare, so afternoon remains golden and moonlight stays cool silver.
          outgoingLight = mix(outgoingLight, max(outgoingLight, uWaterLightColor * 0.98), waterGlintWeight);
          diffuseColor.a = clamp(diffuseColor.a + waterFresnel * 0.22 * uWaterAbove + waterGlintWeight * 0.08, 0.0, 0.82);
          #include <opaque_fragment>
        `);
    };
  }

  customProgramCacheKey(): string {
    // Quality and time of day change uniforms, never shader programs.
    return 'deepbreath-water-sky-v1';
  }

  update(time: number, lighting: LightingState, cameraY: number, quality: RenderQuality): void {
    const uniforms = this.waterUniforms;
    uniforms.uWaterTime.value = time;
    uniforms.uWaterDetail.value = quality.waterDetail;
    uniforms.uWaterAbove.value = THREE.MathUtils.smoothstep(cameraY, -0.65, 0.9);
    uniforms.uWaterSky.value.setRGB(...lighting.skyColor, THREE.SRGBColorSpace);
    uniforms.uWaterHorizon.value.setRGB(...lighting.horizonColor, THREE.SRGBColorSpace);
    uniforms.uWaterLightColor.value.setRGB(...lighting.lightColor, THREE.SRGBColorSpace);
    // The game's camera sits just above a small strip of ocean, while the sky
    // is a color gradient rather than a distant celestial disc. Compress the
    // reflected source's elevation and horizontal travel into that visible
    // strip, preserving east/west motion and its changing color.
    uniforms.uWaterLightDirection.value.set(
      lighting.direction[0] * 0.14,
      0.09 + lighting.direction[1] * 0.12,
      -1,
    ).normalize();
    uniforms.uWaterLightStrength.value = 0.42 + lighting.sunIntensity * 0.24;
    this.color.copy(this.dayWater).lerp(this.nightWater, lighting.nightMix);
    this.opacity = THREE.MathUtils.lerp(0.34, 0.56, uniforms.uWaterAbove.value);
  }
}
