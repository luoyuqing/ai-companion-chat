import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Emotion } from "../services/api";

interface Girlfriend3DProps {
  emotion: Emotion;
  speaking: boolean;
  modelUrl?: string;
}

interface EmotionBlend {
  smile: number;
  eyeOpen: number;
  browTilt: number;
  headLift: number;
  chestBounce: number;
  handRaise: number;
  shoulderDrop: number;
  headBack: number;
  smileWave: number;
}

const EMOTION_PRESET: Record<Emotion, EmotionBlend> = {
  happy: { smile: 1.15, eyeOpen: 1, browTilt: -0.18, headLift: 0.02, chestBounce: 0.03, handRaise: 0.75, shoulderDrop: 0, headBack: 0, smileWave: 0.1 },
  sad: { smile: 0.65, eyeOpen: 0.8, browTilt: 0.14, headLift: -0.06, chestBounce: -0.01, handRaise: 0.02, shoulderDrop: 0.03, headBack: 0, smileWave: 0 },
  surprise: { smile: 0.85, eyeOpen: 1.1, browTilt: -0.24, headLift: 0.08, chestBounce: 0.07, handRaise: 0.35, shoulderDrop: 0, headBack: 0.02, smileWave: 0.02 },
  wink: { smile: 0.78, eyeOpen: 0.45, browTilt: -0.1, headLift: 0.03, chestBounce: 0.05, handRaise: 0.3, shoulderDrop: 0, headBack: 0, smileWave: 0.05 },
  neutral: { smile: 1, eyeOpen: 0.9, browTilt: 0, headLift: 0, chestBounce: 0, handRaise: 0, shoulderDrop: 0, headBack: 0, smileWave: 0 },
  angry: { smile: 0.65, eyeOpen: 0.72, browTilt: 0.22, headLift: -0.02, chestBounce: 0.01, handRaise: 0, shoulderDrop: 0.12, headBack: 0.08, smileWave: 0 },
  love: { smile: 1.3, eyeOpen: 1.05, browTilt: -0.12, headLift: 0.03, chestBounce: 0.04, handRaise: 0.95, shoulderDrop: 0, headBack: 0, smileWave: 0.14 }
};

function cloneScene(source: THREE.Object3D): THREE.Group {
  const clone = source.clone(true) as THREE.Group;
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  const cloneSkinnedMeshes: THREE.SkinnedMesh[] = [];
  const cloneBones: THREE.Bone[] = [];
  const boneMap = new Map<string, THREE.Bone>();

  source.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) {
      skinnedMeshes.push(node as THREE.SkinnedMesh);
    }
  });
  clone.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) {
      cloneSkinnedMeshes.push(node as THREE.SkinnedMesh);
    }
    if ((node as THREE.Bone).isBone) {
      cloneBones.push(node as THREE.Bone);
    }
  });
  cloneBones.forEach((bone) => boneMap.set(bone.name, bone));
  cloneSkinnedMeshes.forEach((mesh, index) => {
    const sourceMesh = skinnedMeshes[index];
    if (!sourceMesh?.skeleton) return;
    const orderedBones = sourceMesh.skeleton.bones.map((bone) => boneMap.get(bone.name)).filter(Boolean) as THREE.Bone[];
    if (orderedBones.length) {
      mesh.bind(new THREE.Skeleton(orderedBones, sourceMesh.skeleton.boneInverses), mesh.matrixWorld);
    }
  });

  return clone;
}

function normalizeModelScene(scene: THREE.Group): THREE.Group {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxAxis = Math.max(size.x, size.y, size.z, 0.001);
  const scale = 1.75 / maxAxis;
  scene.position.sub(center);
  scene.scale.setScalar(scale);
  scene.position.y -= 0.15;

  scene.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) {
      const mesh = node as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  return scene;
}

function setMorphInfluence(scene: THREE.Object3D, matchers: string[], value: number) {
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) {
      return;
    }
    Object.entries(mesh.morphTargetDictionary).forEach(([name, index]) => {
      const normalized = name.toLowerCase();
      if (matchers.some((matcher) => normalized.includes(matcher))) {
        mesh.morphTargetInfluences![index] = THREE.MathUtils.lerp(mesh.morphTargetInfluences![index] || 0, value, 0.12);
      }
    });
  });
}

function findBone(scene: THREE.Object3D, matchers: string[]) {
  let found: THREE.Bone | null = null;
  scene.traverse((node) => {
    if (found || !(node as THREE.Bone).isBone) return;
    const name = node.name.toLowerCase();
    if (matchers.some((matcher) => name.includes(matcher))) {
      found = node as THREE.Bone;
    }
  });
  return found;
}

function lerpBoneRotation(bone: THREE.Bone | null, target: Partial<THREE.Euler>, alpha = 0.08) {
  if (!bone) return;
  if (typeof target.x === "number") bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, target.x, alpha);
  if (typeof target.y === "number") bone.rotation.y = THREE.MathUtils.lerp(bone.rotation.y, target.y, alpha);
  if (typeof target.z === "number") bone.rotation.z = THREE.MathUtils.lerp(bone.rotation.z, target.z, alpha);
}

interface ModelRig {
  head: THREE.Bone | null;
  leftArm: THREE.Bone | null;
  rightArm: THREE.Bone | null;
  leftShoulder: THREE.Bone | null;
  rightShoulder: THREE.Bone | null;
}

function resolveModelRig(scene: THREE.Object3D): ModelRig {
  return {
    head: findBone(scene, ["head", "neck"]),
    leftArm: findBone(scene, ["leftupperarm", "upper_arm.l", "mixamorigleftarm", "leftarm", "arm_l", "l_arm"]),
    rightArm: findBone(scene, ["rightupperarm", "upper_arm.r", "mixamorigrightarm", "rightarm", "arm_r", "r_arm"]),
    leftShoulder: findBone(scene, ["leftshoulder", "shoulder.l", "l_shoulder"]),
    rightShoulder: findBone(scene, ["rightshoulder", "shoulder.r", "r_shoulder"])
  };
}

function applyModelEmotion(scene: THREE.Object3D, rig: ModelRig | null, emotion: Emotion, speaking: boolean, elapsed: number) {
  const preset = EMOTION_PRESET[emotion];
  const smile = emotion === "happy" || emotion === "love" ? 0.75 + Math.sin(elapsed * 3.2) * preset.smileWave : emotion === "wink" ? 0.45 : 0;
  const sad = emotion === "sad" ? 0.7 : 0;
  const angry = emotion === "angry" ? 0.7 : 0;
  const surprise = emotion === "surprise" ? 0.72 : 0;
  const blink = emotion === "wink" ? 0.65 : Math.max(0, Math.sin(elapsed * 0.8) > 0.985 ? 0.8 : 0);
  const mouth = speaking ? 0.35 + Math.max(0, Math.sin(elapsed * 18)) * 0.2 : emotion === "love" ? 0.08 : 0;

  setMorphInfluence(scene, ["smile", "happy", "joy", "mouthhappy"], smile);
  setMorphInfluence(scene, ["sad", "frown", "sorrow"], sad);
  setMorphInfluence(scene, ["angry", "anger"], angry);
  setMorphInfluence(scene, ["surprise", "surprised", "aa", "oh"], Math.max(surprise, mouth));
  setMorphInfluence(scene, ["blink", "wink", "eyeclose"], blink);
  setMorphInfluence(scene, ["mouthopen", "jawopen", "viseme", "aa"], mouth);

  if (rig) {
    const wave = Math.sin(elapsed * 2.8);
    const raise = preset.handRaise;
    const shoulderDrop = preset.shoulderDrop;
    const angryHeadBack = preset.headBack;

    lerpBoneRotation(rig.leftArm, { x: -0.25 - raise * 1.15 + wave * raise * 0.12, z: 0.18 + raise * 0.55 }, 0.1);
    lerpBoneRotation(rig.rightArm, { x: -0.25 - raise * 0.85 - wave * raise * 0.08, z: -0.18 - raise * 0.45 }, 0.1);
    lerpBoneRotation(rig.leftShoulder, { z: shoulderDrop * 0.6 }, 0.09);
    lerpBoneRotation(rig.rightShoulder, { z: -shoulderDrop * 0.6 }, 0.09);
    lerpBoneRotation(rig.head, { x: preset.browTilt * 0.28 - angryHeadBack * 0.8, z: emotion === "love" ? Math.sin(elapsed * 2.2) * 0.08 : 0 }, 0.1);
  }
}

function ModelBody({ modelUrl, emotion, speaking }: { modelUrl: string; emotion: Emotion; speaking: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const rigRef = useRef<ModelRig | null>(null);
  const [model, setModel] = useState<THREE.Group | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setModel(null);
    setFailed(false);
    mixerRef.current = null;
    rigRef.current = null;

    const loader = new GLTFLoader();
    loader.load(
      modelUrl,
      (gltf) => {
        if (!active) return;
        const scene = normalizeModelScene(cloneScene(gltf.scene));
        rigRef.current = resolveModelRig(scene);
        if (gltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(scene);
          const action = mixer.clipAction(gltf.animations[0]);
          action.play();
          mixerRef.current = mixer;
        }
        setModel(scene);
      },
      undefined,
      () => {
        if (active) setFailed(true);
      }
    );

    return () => {
      active = false;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
    };
  }, [modelUrl]);

  useFrame((state, delta) => {
    mixerRef.current?.update(delta);
    if (!groupRef.current || !model) return;

    const preset = EMOTION_PRESET[emotion];
    const elapsed = state.clock.getElapsedTime();
    const breath = Math.sin(elapsed * 1.6) * 0.015;
    const speakingPulse = speaking ? Math.sin(elapsed * 12) * 0.035 : 0;
    const handLift = preset.handRaise * 0.04;
    const shoulderDrop = preset.shoulderDrop * 0.18;
    const headBack = preset.headBack * 0.2;
    groupRef.current.rotation.y = Math.sin(elapsed * 0.55) * 0.08;
    groupRef.current.rotation.x = preset.browTilt * 0.18 + speakingPulse - headBack;
    groupRef.current.position.y = -0.25 + preset.headLift + breath + handLift - shoulderDrop + (speaking ? 0.035 : 0);
    groupRef.current.position.z = -headBack;
    groupRef.current.scale.setScalar(1 + preset.chestBounce * 0.9 + (speaking ? 0.012 : 0));
    applyModelEmotion(model, rigRef.current, emotion, speaking, elapsed);
  });

  if (failed) {
    return <GirlBody emotion={emotion} speaking={speaking} />;
  }

  return (
    <group ref={groupRef} position={[0, -0.25, 0]}>
      {model ? <primitive object={model} /> : <GirlBody emotion="neutral" speaking={false} />}
    </group>
  );
}

function GirlBody({ emotion, speaking }: { emotion: Emotion; speaking: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Mesh>(null);
  const mouthRef = useRef<THREE.Mesh>(null);
  const leftEyeRef = useRef<THREE.Mesh>(null);
  const rightEyeRef = useRef<THREE.Mesh>(null);
  const leftPupilRef = useRef<THREE.Mesh>(null);
  const rightPupilRef = useRef<THREE.Mesh>(null);
  const chestRef = useRef<THREE.Mesh>(null);
  const neckRef = useRef<THREE.Mesh>(null);
  const centerArmRef = useRef<THREE.Mesh>(null);
  const leftArmRef = useRef<THREE.Mesh>(null);
  const rightArmRef = useRef<THREE.Mesh>(null);

  const blinkCycle = useRef(0);
  const blinkState = useRef(1);
  const materials = useMemo(() => {
    const skin = new THREE.MeshStandardMaterial({ color: 0xe4a8b6 });
    const jacket = new THREE.MeshStandardMaterial({ color: 0x1f2944 });
    const face = new THREE.MeshStandardMaterial({ color: 0xefc4bb });
    const hair = new THREE.MeshStandardMaterial({ color: 0x5f3a2b });
    const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const eyeIris = new THREE.MeshStandardMaterial({ color: 0x1f1f2c });
    const pupil = new THREE.MeshStandardMaterial({ color: 0x2c3e50 });
    const mouth = new THREE.MeshStandardMaterial({ color: 0x5a2a3f });
    const arm = new THREE.MeshStandardMaterial({ color: 0xb58ea3 });
    return { skin, jacket, face, hair, eyeWhite, eyeIris, pupil, mouth, arm };
  }, []);

  const preset = useMemo(() => EMOTION_PRESET[emotion], [emotion]);
  const eyeTarget = useRef({ left: preset.eyeOpen, right: preset.eyeOpen });
  const smileTarget = useRef(preset.smile);
  const browTarget = useRef(preset.browTilt);
  const chestTarget = useRef(preset.chestBounce);
  const handTarget = useRef(preset.handRaise);
  const shoulderTarget = useRef(preset.shoulderDrop);
  const headBackTarget = useRef(preset.headBack);

  useFrame((state, delta) => {
    if (!groupRef.current || !mouthRef.current || !leftEyeRef.current || !rightEyeRef.current || !headRef.current || !chestRef.current || !neckRef.current || !centerArmRef.current || !leftArmRef.current || !rightArmRef.current) {
      return;
    }

    const elapsed = state.clock.getElapsedTime();
    const wave = Math.sin(elapsed * 2);
    const gestureWave = Math.sin(elapsed * 4);
    const current = EMOTION_PRESET[emotion];
    eyeTarget.current = {
      left: current.eyeOpen + Math.abs(wave) * 0.02,
      right: current.eyeOpen + Math.abs(wave) * 0.02
    };
    smileTarget.current = current.smile;
    browTarget.current = current.browTilt;
    chestTarget.current = current.chestBounce;
    handTarget.current = current.handRaise;
    shoulderTarget.current = current.shoulderDrop;
    headBackTarget.current = current.headBack;

    blinkCycle.current += delta;
    const shouldBlink = blinkCycle.current > 4;
    if (shouldBlink && Math.random() > 0.96) {
      blinkCycle.current = 0;
      blinkState.current = 0.08;
    }
    blinkState.current = Math.max(0.09, blinkState.current + delta * 4);
    if (blinkState.current > 1) blinkState.current = 1;

    const speakingPulse = speaking ? (Math.sin(elapsed * 18) + 1) / 24 : 0;
    const smileArcWave = current.smileWave ? Math.sin(elapsed * 3.5) * current.smileWave : 0;

    const targetMouthOpen = Math.max(0.05, (speaking ? 0.22 : 0.15) + speakingPulse);
    mouthRef.current.scale.set(1.6 * (smileTarget.current + smileArcWave), 1, 1);
    mouthRef.current.scale.y = targetMouthOpen;
    mouthRef.current.rotation.z = -0.18 + (smileTarget.current - 1) * 0.18 + smileArcWave * 0.45;

    const targetEye = speaking ? eyeTarget.current.left * 0.88 : eyeTarget.current.left;
    leftEyeRef.current.scale.y = Math.max(0.05, targetEye * blinkState.current);
    rightEyeRef.current.scale.y = Math.max(0.05, eyeTarget.current.right * blinkState.current);

    const driftX = Math.sin(state.clock.getElapsedTime() * 0.9) * 0.015;
    const driftY = Math.cos(state.clock.getElapsedTime() * 0.85) * 0.005;
    leftEyeRef.current.position.x = -0.16 + driftX;
    rightEyeRef.current.position.x = 0.16 + driftX;
    leftEyeRef.current.position.y = 0.03 + driftY;
    rightEyeRef.current.position.y = 0.03 + driftY;

    if (leftPupilRef.current) leftPupilRef.current.position.x = Math.sin(elapsed * 1.8) * 0.012;
    if (rightPupilRef.current) rightPupilRef.current.position.x = Math.sin(elapsed * 1.8 + 0.6) * 0.012;

    groupRef.current.rotation.y = Math.sin(elapsed * 0.6) * 0.12;
    groupRef.current.rotation.x = browTarget.current * 0.35 + (speaking ? -0.06 : 0) - headBackTarget.current * 0.25;
    headRef.current.rotation.x = browTarget.current * 0.6 - headBackTarget.current * 1.2;
    headRef.current.position.y = 1.3 + current.headLift + (speaking ? 0.025 : 0) - shoulderTarget.current * 0.2;
    headRef.current.position.z = -headBackTarget.current;
    neckRef.current.position.y = 1.22 - shoulderTarget.current * 0.24;
    chestRef.current.position.y = -0.05 + chestTarget.current * (speaking ? 1.2 : 1) - shoulderTarget.current + Math.sin(elapsed * 8) * 0.01;

    centerArmRef.current.position.y = 0.74 - shoulderTarget.current * 0.6;
    centerArmRef.current.rotation.x = 0.55 - handTarget.current * 0.2;
    leftArmRef.current.position.y = 0.68 + handTarget.current * 0.26 - shoulderTarget.current * 0.65;
    rightArmRef.current.position.y = 0.68 + handTarget.current * 0.32 - shoulderTarget.current * 0.65;
    leftArmRef.current.rotation.x = -0.25 - handTarget.current * 1.15 + gestureWave * handTarget.current * 0.08;
    rightArmRef.current.rotation.x = -0.25 - handTarget.current * 1.35 - gestureWave * handTarget.current * 0.1;
    leftArmRef.current.rotation.z = 0.2 + handTarget.current * 0.48;
    rightArmRef.current.rotation.z = -0.2 - handTarget.current * 0.52;
  });

  return (
    <group ref={groupRef} position={[0, -0.6, 0]}>
      <mesh ref={chestRef} position={[0, 0.85, 0]} material={materials.skin}>
        <boxGeometry args={[1.15, 0.8, 0.45]} />
      </mesh>

      <mesh ref={neckRef} position={[0, 1.22, 0.06]} castShadow material={materials.jacket}>
        <boxGeometry args={[0.24, 0.28, 0.18]} />
      </mesh>

      <mesh ref={headRef} position={[0, 1.58, 0]} castShadow material={materials.face}>
        <sphereGeometry args={[0.35, 32, 32]} />
      </mesh>

      <mesh position={[0, 1.9, -0.13]} rotation={[-0.9, 0, 0]} material={materials.hair}>
        <torusGeometry args={[0.38, 0.1, 12, 20]} />
      </mesh>

      <mesh ref={leftEyeRef} position={[-0.14, 1.55, 0.31]} material={materials.eyeWhite}>
        <sphereGeometry args={[0.08, 16, 16]} />
      </mesh>
      <mesh position={[-0.14, 1.55, 0.31]} scale={[0.6, 1, 0.6]} material={materials.eyeIris}>
        <sphereGeometry args={[0.05, 12, 12]} />
      </mesh>
      <mesh ref={leftPupilRef} position={[-0.14, 1.55, 0.35]} material={materials.pupil}>
        <sphereGeometry args={[0.028, 8, 8]} />
      </mesh>

      <mesh ref={rightEyeRef} position={[0.14, 1.55, 0.31]} material={materials.eyeWhite}>
        <sphereGeometry args={[0.08, 16, 16]} />
      </mesh>
      <mesh position={[0.14, 1.55, 0.31]} scale={[0.6, 1, 0.6]} material={materials.eyeIris}>
        <sphereGeometry args={[0.05, 12, 12]} />
      </mesh>
      <mesh ref={rightPupilRef} position={[0.14, 1.55, 0.35]} material={materials.pupil}>
        <sphereGeometry args={[0.028, 8, 8]} />
      </mesh>

      <mesh ref={mouthRef} position={[0, 1.44, 0.31]} material={materials.mouth}>
        <boxGeometry args={[0.26, 0.09, 0.045]} />
      </mesh>

      <mesh ref={centerArmRef} position={[0, 0.74, 0]} rotation={[0.55, 0, 0]} material={materials.arm}>
        <cylinderGeometry args={[0.02, 0.2, 0.6, 8]} />
      </mesh>
      <mesh ref={rightArmRef} position={[0.28, 0.68, 0]} rotation={[-0.25, 0, -0.2]} material={materials.arm}>
        <cylinderGeometry args={[0.012, 0.12, 0.7, 8]} />
      </mesh>
      <mesh ref={leftArmRef} position={[-0.28, 0.68, 0]} rotation={[-0.25, 0, 0.2]} material={materials.arm}>
        <cylinderGeometry args={[0.012, 0.12, 0.7, 8]} />
      </mesh>
    </group>
  );
}

export function Girlfriend3D({ emotion, speaking, modelUrl }: Girlfriend3DProps) {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const preset = EMOTION_PRESET[emotion];

  return (
    <div
      className="avatar-3d-shell"
      aria-label="3D数字女友形象"
      data-emotion={emotion}
      data-motion-preset={`hand:${preset.handRaise.toFixed(2)};shoulder:${preset.shoulderDrop.toFixed(2)};headBack:${preset.headBack.toFixed(2)}`}
    >
      <Canvas camera={{ position: [0, 1.2, 3.2], fov: 42 }} dpr={dpr} shadows>
        <ambientLight intensity={0.45} />
        <directionalLight castShadow position={[3, 5, 4]} intensity={1.2} color="#ffd6e7" />
        <directionalLight position={[-2, 2, -2]} intensity={0.35} color="#7ea8ff" />
        <spotLight position={[-4, 4, 2]} angle={0.38} penumbra={0.7} intensity={0.35} color="#ffffff" />
        {modelUrl ? <ModelBody modelUrl={modelUrl} emotion={emotion} speaking={speaking} /> : <GirlBody emotion={emotion} speaking={speaking} />}
      </Canvas>
    </div>
  );
}
