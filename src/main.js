import './styles.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
//import { Mesh } from 'three';
import { WebGLRenderer } from "three";
import { SRGBColorSpace } from 'three';
import { EffectComposer, RenderPass, EffectPass, OutlineEffect, BlendFunction, SMAAEffect } from 'postprocessing';
import Stats from 'three/examples/jsm/libs/stats.module.js';

function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

const IS_MOBILE = isMobile();

// Performance monitoring
let frameCount = 0;
let lastTime = performance.now();
let fps = 60;

window.addEventListener('error', (e) => {
    console.error('💥 CRASH DETECTED:', e.message);
    alert('CRASH: ' + e.message + ' at line ' + e.lineno);
});

window.addEventListener('unhandledrejection', (e) => {
    console.error('💥 PROMISE CRASH:', e.reason);
    alert('PROMISE ERROR: ' + e.reason);
});

console.log('App loaded:', new Date().toISOString());
class HotspotManager {
    constructor() {
        this.init();
        this.hotspots = [];
        this.doorAnimations = {};
        this.doorHotspots = [];
        this.hotspotsData = null;
        this.selectedHotspot = null;
        this.currentHotspotIndex = 0;
        this.activeMode = null;
        this.allHotspotsAll = [];
        this.walkThroughMode = false;
        this.walkThroughSteps = [];
        this.currentWalkStep = 0;

        this.currentHotspotIndex = 0;
        this.visitedHotspots = new Set();
        this.isAnimating = false;
        this.needsUpdate = false;
        this.frameCount = 0;
        this._camAnim = null; // single camera animation state — driven by main loop
        this._lastFrameTime = 0;
        this.outlineEnabled = false; // flip to true to re-enable selection glow

        // Performance settings
        this.LOD_DISTANCE = IS_MOBILE ? 15 : 10;
        this.CULL_DISTANCE = IS_MOBILE ? 30 : 50;
        this.targetFPS = IS_MOBILE ? 30 : 60;
        this._frameBudget = 1000 / this.targetFPS;

        // Simple raycast optimization
        this.raycastFrameCount = 0;
        this.raycastInterval = IS_MOBILE ? 15 : 10; // Check occlusion every N frames
        this.lastOcclusionResults = new Map(); // Simple cache for smoother transitions

        // Object pooling
        this.raycaster = new THREE.Raycaster();
        this.tempVector = new THREE.Vector3();
        this.tempVector2 = new THREE.Vector3();
        this.tempMatrix = new THREE.Matrix4();

        this.hasLoggedRendererInfo = false;
        this.activeHazardFilter = null;

    }

    async init() {
        console.log('Initializing...');
        // Create scene
        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock();

        // Optimized HDR loading
        const rgbeLoader = new RGBELoader();
        rgbeLoader.load('media/model/cannon_1k.hdr', (hdrTexture) => {
            hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
            // Optimized filtering
            hdrTexture.minFilter = THREE.LinearFilter;
            hdrTexture.magFilter = THREE.LinearFilter;
            hdrTexture.generateMipmaps = false; // Disable mipmaps for HDR
            hdrTexture.needsUpdate = true;
            this.scene.environment = hdrTexture;
        });

        // Optimized gradient background
        const gradientCanvas = document.createElement('canvas');
        gradientCanvas.width = 1;
        gradientCanvas.height = IS_MOBILE ? 128 : 256; // Smaller on mobile
        const ctx = gradientCanvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 256);
        gradient.addColorStop(0, '#7C7C7C'); // bottom - white
        gradient.addColorStop(1, '#ffffff'); // top - light grey
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 1, gradientCanvas.height);
        const gradientTexture = new THREE.CanvasTexture(gradientCanvas);
        gradientTexture.generateMipmaps = false;
        this.scene.background = gradientTexture;

        // Create camera (fov, aspect, near, far)
        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(0, 0, 0);
        this.camera.lookAt(0, 0, 0);
        //this.camera.setFocalLength(50);


        // Highly optimized renderer
        this.renderer = new WebGLRenderer({
            powerPreference: "high-performance",
            antialias: false, // SMAA via postprocessing handles AA — hardware MSAA would double the cost
            stencil: false,
            depth: true,
            alpha: false,
            preserveDrawingBuffer: false,
            failIfMajorPerformanceCaveat: false
        });

        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(IS_MOBILE ? 1 : Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = SRGBColorSpace;

        // Conditional shadows and tone mapping
        if (!IS_MOBILE) {
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            this.renderer.toneMapping = THREE.LinearToneMapping;
            this.renderer.toneMappingExposure = 0.95;
        } else {
            this.renderer.shadowMap.enabled = false;
            this.renderer.toneMapping = THREE.NoToneMapping;
        }
        document.getElementById('container').appendChild(this.renderer.domElement);

        // WebGL context loss handler
        this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            alert('WebGL context lost. Please reload the page.');
        }, false);

        // UI elements
        const rightArrow = document.createElement('img');
        rightArrow.src = 'media/MouseControl.svg';
        rightArrow.id = 'mouse-control';
        document.body.appendChild(rightArrow);

        // Optimized lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, IS_MOBILE ? 0.5 : 0.3);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
        directionalLight.position.set(0, 10, 0);
        directionalLight.intensity = 1.75; // more shadow strength
        directionalLight.castShadow = true;

        // Add these shadow properties
        directionalLight.shadow.mapSize.width = 512;
        directionalLight.shadow.mapSize.height = 512;
        directionalLight.shadow.radius = 4;
        directionalLight.shadow.bias = -0.001;
        directionalLight.shadow.camera.near = 0.5;
        directionalLight.shadow.camera.far = 100;
        directionalLight.shadow.camera.left = -25;
        directionalLight.shadow.camera.right = 25;
        directionalLight.shadow.camera.top = 25;
        directionalLight.shadow.camera.bottom = -25;
        directionalLight.shadow.normalBias = 0.02;
        this.scene.add(directionalLight);
        //composer
        // Setup composer only if not mobile
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        // Postprocessing passes

        // Create OutlineEffect
        this.outlineEffect = new OutlineEffect(this.scene, this.camera, {
            selection: [],
            blendFunction: BlendFunction.ALPHA,
            edgeStrength: 2,
            pulseSpeed: 0.0,
            visibleEdgeColor: new THREE.Color('#EF5337'), // Start transparent
            hiddenEdgeColor: new THREE.Color('#EF5337'),
            multisampling: 4,
            // resolution: {
            //     // width: window.innerWidth * Math.min(window.devicePixelRatio, 2),
            //     // height: window.innerHeight * Math.min(window.devicePixelRatio, 2)
            // },
            resolution: { width: window.innerWidth / 2, height: window.innerHeight / 2 },

            xRay: false,
            // Edge detection settings
            patternTexture: null,
            kernelSize: 1,
            blur: true,
            edgeGlow: 0.0,
            usePatternTexture: false
        });
        //SMAA
        const smaaEffect = new SMAAEffect();
        // Create effect pass with both outline and SMAA
        const effectPass = new EffectPass(this.camera, this.outlineEffect, smaaEffect);
        effectPass.renderToScreen = true;

        //add effect pass to composer
        this.composer.addPass(effectPass);

        // Add floor disc
        const floorGeometry = new THREE.CircleGeometry(20, 48);
        const floorMaterial = new THREE.MeshStandardMaterial({
            color: 0xbbbbbb,
            transparent: true,
            opacity: .7,
            roughness: 1.0,
            metalness: 0.0,
            side: THREE.DoubleSide
        });
        const floor = new THREE.Mesh(floorGeometry, floorMaterial);
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -5.5;
        floor.receiveShadow = !IS_MOBILE;
        //this.scene.add(floor);

        // Add controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = IS_MOBILE ? 0.1 : 0.15;
        this.controls.zoomSpeed = 2.0;
        this.controls.enablePan = false;
        this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
        this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;

        // Set orbit boundaries
        this.controls.minDistance = 0.1; // Minimum zoom distance
        this.controls.maxDistance = 30; // Maximum zoom distance
        this.controls.minPolarAngle = Math.PI / 6; // Minimum vertical angle (30 degrees)
        this.controls.maxPolarAngle = Math.PI / 2; // Maximum vertical angle (120 degrees)
        // this.controls.minAzimuthAngle = -Math.PI; // Allow full 360 rotation
        //this.controls.maxAzimuthAngle = Math.PI;
        this.controls.enablePan = true; // Disable panning to keep focus on the model
        this.controls.target.y = 0; // Keep the orbit target at floor level
        let controlsUpdateTimeout = null;
        // Keep target from going below floor
        this.controls.addEventListener('change', () => {
            if (this.controls.target.y < -5.3) {
                this.controls.target.y = -5.4;
            }
            this.controlsChanged = true;

            // Throttle updates on mobile
            if (IS_MOBILE) {
                if (controlsUpdateTimeout) clearTimeout(controlsUpdateTimeout);
                controlsUpdateTimeout = setTimeout(() => {
                    this.cameraChanged = true;
                }, 50);
            } else {
                this.cameraChanged = true;
            }
        });

        // Setup loaders
        this.setupLoaders();

        try {
            // Load model and hotspots
            console.log('Loading model...');
            await this.loadModel();
            console.log('Model loaded successfully');
        } catch (error) {
            console.error('Error during initialization:', error);
            document.getElementById('loadingScreen').innerHTML = `
                        <div class="loading-content">
                            <h2>Error Loading Model</h2>
                            <p>${error.message}</p>
                            <p>Please ensure the model file is in the correct location.</p>
                        </div>
                    `;
        }
        // Event listeners with debouncing
        window.addEventListener('orientationchange', () => {
            this.onWindowResize();
            setTimeout(() => this.onWindowResize(), 500);
        });

        let resizeTimeout = null;
        window.addEventListener('resize', () => {
            if (resizeTimeout) clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.onWindowResize();
            }, 100);
        });
        this.setupFullscreenButton();
        this.setupResetButton();
        this.setupTechSpecToggle();
        this.setupPDFButton();
        this.setupModeFilter();
        this.setupModeOverlay();
        this.showOverlay(1);

        // Performance monitoring setup
        if (!IS_MOBILE) {
            // this.stats = new Stats();
            // document.body.appendChild(this.stats.dom);
        }
        // Start animation loop
        this.animate();
        console.log('Initialization complete');
    }

    setupLoaders() {
        // Setup DRACO loader
        this.dracoLoader = new DRACOLoader();
        this.dracoLoader.setDecoderPath('./lib/draco/');
        this.dracoLoader.preload();

        // Setup GLTF loader with loading manager
        const loadingManager = new THREE.LoadingManager();
        this.loader = new GLTFLoader(loadingManager);
        this.loader.setDRACOLoader(this.dracoLoader);
        this.loadingManager = loadingManager;
    }

    async loadModel() {
        return new Promise((resolve, reject) => {
            // Reuse loading manager
            const loadingManager = this.loadingManager;

            // Setup loading manager callbacks
            loadingManager.onProgress = (url, loaded, total) => {
                const progress = (loaded / total) * 100;
                document.getElementById('progress').style.width = progress + '%';
                console.log(`Loading progress: ${progress}%`);
            };

            loadingManager.onLoad = () => {
                const loadingEl = document.getElementById('loadingScreen');
                loadingEl.style.opacity = 0;
                setTimeout(() => {
                    loadingEl.style.display = 'none';
                }, 300); // Match CSS transition duration
                resolve();
            };

            loadingManager.onError = (url) => {
                console.error('Error loading:', url);
                reject(new Error(`Failed to load: ${url}`));
            };


            const modelPath = 'media/model/Line11CasePacker_v2.glb';
            console.log('Loading model from:', modelPath);

            // this.loader.load(modelPath, (gltf) => {
            //     console.log('Model loaded!');
            //     scene.add(gltf.scene);
            // }, undefined, (err) => {
            //     console.error('Failed to load model:', err);
            // });
            this.loader.load(
                modelPath,
                (gltf) => {
                    console.log('Model loaded successfully');

                    console.log("🔍 Checking material variants...");
                    // ✅ Get global variant list

                    this.model = gltf.scene;
                    // Store meshIndex for each mesh so we can reference default material later
                    gltf.scene.traverse((obj) => {
                        if (obj.isMesh) {
                            if (gltf.parser.json.meshes) {
                                const meshDefIndex = gltf.parser.json.meshes.findIndex(mesh => mesh.name === obj.name);
                                if (meshDefIndex !== -1) {
                                    obj.userData.meshIndex = meshDefIndex;
                                }
                            }
                        }
                    });

                    this.gltf = gltf;

                    //hide object after load
                    this.cableContentsObject = this.model.getObjectByName("CableBinContents");
                    if (this.cableContentsObject) {
                        this.cableContentsObject.visible = false;
                    }

                    // Setup animation mixer and register animations
                    this.mixer = new THREE.AnimationMixer(this.model);
                    this.animationMixers = {};
                    this.animationsByName = {};

                    gltf.animations.forEach((clip) => {
                        this.animationMixers[clip.name] = this.mixer;
                        this.animationsByName[clip.name] = clip;
                        console.log(`🎞️ Loaded animation: ${clip.name}`);
                    });

                    this.cameras = {};
                    gltf.scene.traverse(obj => {
                        if (obj.isCamera && obj.name.startsWith("Cam_")) {
                            const key = obj.name.replace("Cam_", ""); // Extract variant name
                            this.cameras[key] = obj;
                            console.log(`📸 Found camera: ${obj.name}`);
                        }
                    });
                    // ✅ Get global variant list
                    const variantExtension = gltf.parser.json.extensions?.KHR_materials_variants;
                    if (variantExtension && variantExtension.variants) {
                        this.variantList = variantExtension.variants.map(v => v.name);
                        console.log('✅ Material Variants Found:', this.variantList);
                    }

                    // Build raycastable mesh list in a single traversal
                    this.interactiveMeshes = [];
                    const nodePositions = {};
                    const targetNodes = ['Main_FrontView', 'Main_RearView', 'Main_LeftView', 'Main_RightView', '01_ChargingSocket'];

                    this.model.traverse((node) => {
                        if (node.isMesh && node.visible) {
                            this.interactiveMeshes.push(node);
                        }
                    });

                    // Log summary of target nodes
                    console.log('=== Target Nodes Summary ===');
                    targetNodes.forEach(nodeName => {
                        if (nodePositions[nodeName]) {
                            console.log(`Found ${nodeName}:`, nodePositions[nodeName]);
                        } else {
                            console.log(`Node ${nodeName} not found in model`);
                        }
                    });
                    console.log('============================');

                    this.scene.add(this.model);
                    let triangleCount = 0;
                    let meshCount = 0;

                    this.model.traverse((obj) => {
                        if (obj.isMesh) {
                            meshCount++;

                            const geom = obj.geometry;
                            triangleCount += geom.index
                                ? geom.index.count / 3
                                : geom.attributes.position.count / 3;
                        }
                    });

                    console.log("🔺 Triangles:", triangleCount);
                    console.log("📦 Meshes:", meshCount);
                    // Set texture filtering for all textures in model materials
                    this.model.traverse((node) => {
                        if (node.isMesh && node.material) {
                            const materials = Array.isArray(node.material) ? node.material : [node.material];
                            materials.forEach((mat) => {
                                [
                                    'map',
                                    'normalMap',
                                    'roughnessMap',
                                    'metalnessMap',
                                    'aoMap',
                                    'emissiveMap',
                                    'alphaMap',
                                    'bumpMap',
                                    'displacementMap',
                                    'specularMap',
                                    'envMap'
                                ].forEach((mapType) => {
                                    if (mat[mapType]) {
                                        mat[mapType].minFilter = THREE.LinearMipmapLinearFilter;
                                        mat[mapType].magFilter = THREE.LinearFilter;
                                        mat[mapType].needsUpdate = true;
                                    }
                                });
                            });
                        }
                    });

                    // Center model
                    const box = new THREE.Box3().setFromObject(this.model);
                    const center = box.getCenter(new THREE.Vector3());
                    this.model.position.sub(center);


                    // 180 degrees in radians
                    this.model.rotation.y = Math.PI / 1.25;

                    // Store model dimensions for positioning hotspots
                    const size = box.getSize(new THREE.Vector3());
                    this.modelSize = size;

                    // Adjust camera
                    const maxDim = Math.max(size.x, size.y, size.z);
                    const fov = this.camera.fov * (Math.PI / 180);
                    let cameraZ = Math.abs(maxDim / Math.tan(fov / 2));
                    // Enforce a comfortable default reset distance (e.g., z=2)
                    const defaultResetDistance = 5; // Between minDistance (0.1) and maxDistance (25)
                    this.camera.position.set(5, 3, 12);
                    this.camera.lookAt(0, 0, 0);
                    this.camera.updateProjectionMatrix();
                    this.initialCameraPosition = new THREE.Vector3(12, 0, 8);
                    this.initialCameraTarget = new THREE.Vector3(0, 0, 0);

                    //help see what camera position is good and set that above 
                    // this.controls.addEventListener('change', () => {
                    //     console.log('📸 Camera Position:', this.camera.position);
                    //     console.log('🎯 Camera Rotation:', this.camera.rotation);
                    // });

                    // Set orbit controls target to model center (orbit mode)
                    this.controls.target.set(0, 0, 0);
                    this.controls.update();
                    // Create hotspots after model is loaded
                    this.createDefaultHotspots();

                    resolve();
                },
                (xhr) => {
                    const percent = xhr.loaded / xhr.total * 100;
                    console.log(`${percent}% loaded`);
                },
                (error) => {
                    console.error('Error loading model:', error);
                }
            );
        });
    }

    clearAllVariants() {
        if (!this.gltf) return;

        this.model.traverse((object) => {
            if (!object.isMesh) return;

            const ext = object.userData?.gltfExtensions?.KHR_materials_variants;

            if (ext?.mappings?.length) {
                // Find the fallback/default material from the GLTF definition
                const meshIndex = object.userData.meshIndex;
                if (meshIndex !== undefined) {
                    const meshDef = this.gltf.parser.json.meshes[meshIndex];
                    const primitive = meshDef?.primitives?.[0];

                    if (primitive?.material !== undefined) {
                        this.gltf.parser.getDependency('material', primitive.material).then((defaultMat) => {
                            object.material = defaultMat;
                            object.material.needsUpdate = true;
                            this.needsUpdate = true;
                        });
                    }
                }
            }
        });

        console.log('🔁 Reset all materials to their base (default) version');
    }

    handleHotspotClick(hotspot) {

        // Toggle OPEN/CLOSE nodes for animation-type hotspots (no real animation)
        if (hotspot.data.type === 'animation') {
            const base = this.normalizeBase(hotspot.data.node);
            const { openNode, closeNode } = this.getDoorNodes(base);

            if (openNode && closeNode) {
                const willOpen = !openNode.visible;
                openNode.visible = willOpen;
                closeNode.visible = !willOpen;
                this.needsUpdate = true; // visibility change requires re-render
            } else {
                console.warn(`Door nodes not found for base: ${base}`, { openNode, closeNode });
            }
        }

        //*** NEW: Handle PitNets special case ***
        //*** Handle Aft Cargo Door (PitNets and CargoLocksAft) ***
        if (hotspot.data.node === "20_PitNetsAft" || hotspot.data.node === "21_CargoLocksAft") {
            // Get the aft cargo door nodes
            const aftDoorBase = "19_AftCargoDoor";
            const { openNode: aftOpenNode, closeNode: aftCloseNode } = this.getDoorNodes(aftDoorBase);

            // Get the cargo locks node to hide
            const cargoAftFwdNode = this.scene.getObjectByName("18_CargoDoorLatchAft");

            if (aftOpenNode && aftCloseNode) {
                // Show open door, hide closed door
                aftOpenNode.visible = true;
                aftCloseNode.visible = false;

                // Hide the cargo locks
                if (cargoAftFwdNode) {
                    cargoAftFwdNode.visible = false;
                }

                console.log("✅ PitNets & CargoLocksAft: Opened aft cargo door and hid locks");
            } else {
                console.warn("❌ PitNets & CargoLocksAft: Could not find aft cargo door nodes", { aftOpenNode, aftCloseNode });
            }
        }

        //*** Handle Forward Cargo Door (CargoLocksFwd) ***
        if (hotspot.data.node === "10_CargoLocksFwd") {
            // Get the forward cargo door nodes
            const fwdDoorBase = "09_ForwardCargoDoor";
            const { openNode: fwdOpenNode, closeNode: fwdCloseNode } = this.getDoorNodes(fwdDoorBase);

            // Get the latch node to hide
            const cargoLatchFwdNode = this.scene.getObjectByName("08_CargoDoorLatchForward");

            if (fwdOpenNode && fwdCloseNode) {
                // Show open door, hide closed door
                fwdOpenNode.visible = true;
                fwdCloseNode.visible = false;

                // Hide the latch
                if (cargoLatchFwdNode) {
                    cargoLatchFwdNode.visible = false;
                }

                console.log("✅ CargoLocksFwd: Opened forward cargo door and hid latch");
            } else {
                console.warn("❌ CargoLocksFwd: Could not find forward cargo door nodes", { fwdOpenNode, fwdCloseNode });
            }
        }

        //*** General Latch Visibility Logic ***
        // Handle aft cargo door latch visibility
        const aftDoorNodes = this.getDoorNodes("19_AftCargoDoor");
        const aftLatchNode = this.scene.getObjectByName("18_CargoDoorLatchAft");
        if (aftDoorNodes.openNode && aftDoorNodes.closeNode && aftLatchNode) {
            // If aft door is open, hide latch; if closed, show latch
            aftLatchNode.visible = aftDoorNodes.closeNode.visible;
        }

        // Handle forward cargo door latch visibility  
        const fwdDoorNodes = this.getDoorNodes("09_ForwardCargoDoor");
        const fwdLatchNode = this.scene.getObjectByName("08_CargoDoorLatchForward");
        if (fwdDoorNodes.openNode && fwdDoorNodes.closeNode && fwdLatchNode) {
            // If forward door is open, hide latch; if closed, show latch
            fwdLatchNode.visible = fwdDoorNodes.closeNode.visible;
        }

        const hotspotData = hotspot.data;

        // Deselect previous
        if (this.selectedHotspot && this.selectedHotspot !== hotspot) {
            this.visitedHotspots.add(this.selectedHotspot);
            this.selectedHotspot.element.classList.add('visited');
            this.selectedHotspot.element.style.backgroundImage =
                this.selectedHotspot.data.type === 'animation'
                    ? `url('media/door_default.png')`
                    : `url('${this.selectedHotspot.data.icon || 'media/Info_default.png'}')`;
            this.selectedHotspot.info.style.display = 'none';
            this.selectedHotspot.info.classList.remove('active');
        }

        this.selectedHotspot = hotspot;
        hotspot.element.classList.remove('visited');
        this.visitedHotspots.add(hotspot);

        // Update icon state
        hotspot.element.style.backgroundImage = hotspotData.type === 'animation'
            ? `url('media/door_selected.png')`
            : `url('${hotspotData.icon || 'media/Info_Selected.png'}')`;

        // 🚫 Don’t show panel for animation hotspots
        if (hotspotData.type !== 'animation') {
            hotspot.info.style.display = 'block';
            hotspot.info.classList.add('active');
            const startCollapsed = IS_MOBILE && hotspotData.mode === 'safety';
            hotspot.info.classList.toggle('collapsed', startCollapsed);
            const cb = hotspot.info.querySelector('.mobile-collapse-btn');
            if (cb) cb.textContent = startCollapsed ? '▴' : '▾';
        } else {
            hotspot.info.style.display = 'none';
            hotspot.info.classList.remove('active');
        }


        // 🔁 Move to predefined camera position if available
        const cameraNode = this.getCameraNode(hotspotData.camera || 'Cam_' + hotspotData.node);

        const hotspotNode = this.model.getObjectByName(hotspotData.node);
        if (cameraNode && cameraNode.isCamera && hotspotNode) {
            const endPos = new THREE.Vector3();
            cameraNode.getWorldPosition(endPos);
            const endTarget = new THREE.Vector3();
            hotspotNode.getWorldPosition(endTarget);
            this._camAnim = {
                startPos: this.camera.position.clone(),
                endPos,
                startTarget: this.controls.target.clone(),
                endTarget,
                startQuat: null,
                endQuat: null,
                startTime: Date.now(),
                duration: 1500,
            };
        } else {
            this.moveToHotspotView(hotspot);
        }
        //outline selected mesh
        let meshToOutline = this.model.getObjectByName(hotspotData.node);
        // If it's an animation door, outline the visible state (open or closed)
        if (hotspotData.type === 'animation') {
            const base = this.normalizeBase(hotspotData.node);
            const { openNode, closeNode } = this.getDoorNodes(base);
            meshToOutline = (openNode && openNode.visible) ? openNode
                : (closeNode && closeNode.visible) ? closeNode
                    : meshToOutline;
        }


        if (meshToOutline) {
            const meshesToSelect = [];

            // If the node is a group or has children, traverse it
            meshToOutline.traverse((child) => {
                if (child.isMesh) {
                    meshesToSelect.push(child);
                }
            });

            // If it is a single mesh with multiple materials, still push it
            if (meshToOutline.isMesh && meshesToSelect.length === 0) {
                meshesToSelect.push(meshToOutline);
            }

            if (meshesToSelect.length > 0) {
                if (this.outlineEnabled) {
                    this.outlineEffect.selection.set(meshesToSelect);
                    this.animateOutlineEdgeStrength(0, 3, 1500);
                }
                console.log('✔ Outline applied to:', meshesToSelect.map(m => m.name));
            } else {
                console.warn('❌ No mesh found to apply outline for:', hotspotData.node);
            }
        } else {
            console.warn('❌ Node not found in model:', hotspotData.node);
        }

        // 🔁 Sync navigation index
        const idx = this.allHotspots.findIndex(h => h.node === hotspotData.node);
        if (idx !== -1) {
            this.currentHotspotIndex = idx;
            this.updateTitleDisplay();
        }

        if (this.walkThroughMode) {
            if (hotspotData.step !== undefined) {
                const stepIdx = this.walkThroughSteps.findIndex(s => s.node === hotspotData.node);
                if (stepIdx !== -1) this.currentWalkStep = stepIdx;
            }
            this.updateStepNavDisplay();
        }
    }

    // ---- Door helpers (Base + Base_open) ----
    normalizeBase(name) {
        // remove trailing .open/.close OR _open/_close if they ever appear
        return (name || '').replace(/(\.|_)(open|close)$/i, '');
    }
    getDoorNodes(base) {
        // CLOSED: Base
        const closeNode = this.model.getObjectByName(base)
            || this.model.getObjectByName(`${base}.close`)
            || this.model.getObjectByName(`${base}_close`);
        // OPEN: Base_open (primary), with dot fallback
        const openNode = this.model.getObjectByName(`${base}_open`)
            || this.model.getObjectByName(`${base}.open`);
        return { openNode, closeNode };
    }
    // Camera finder that tolerates _open/_close suffix in JSON
    getCameraNode(camName) {
        let cam = this.model.getObjectByName(camName);
        if (cam) return cam;
        const fallback = (camName || '').replace(/_(open|close)$/i, '');
        return this.model.getObjectByName(fallback) || null;
    }

    async createDefaultHotspots() {
        const response = await fetch('hotspots.json');
        const hotspotDataList = await response.json();

        // Store the full list of hotspots for navigation
        // exclude both "camera" and "animation" from arrow navigation
        this.allHotspotsAll = hotspotDataList.filter(h => h.type !== 'camera' && h.type !== 'animation');
        this.allHotspots = [...this.allHotspotsAll];



        // 🔎 Filter camera hotspots from JSON
        const cameraHotspots = hotspotDataList.filter(h => h.type === 'camera');

        // 🎯 Get the UI container
        const cameraControls = document.getElementById("cameraControls");
        cameraControls.innerHTML = ''; // Clear existing

        // 🔁 Generate buttons
        cameraHotspots.forEach(camData => {
            const container = document.createElement("div");
            container.className = "cam-btn-container";

            const label = document.createElement("span");
            label.textContent = camData.title;
            label.className = "cam-btn-label";

            container.addEventListener("click", () => {
                document.querySelectorAll(".cam-btn-container.active").forEach(el => {
                    el.classList.remove("active");
                });

                container.classList.add("active");
                const cameraNode = this.model.getObjectByName(camData.camera);
                if (!cameraNode || !cameraNode.isCamera) {
                    console.warn('❌ Camera not found:', camData.camera);
                    return;
                }

                const targetPos = new THREE.Vector3();
                cameraNode.getWorldPosition(targetPos);
                const targetQuat = new THREE.Quaternion();
                cameraNode.getWorldQuaternion(targetQuat);
                const startPos = this.camera.position.clone();
                const startQuat = this.camera.quaternion.clone();
                const startTarget = this.controls.target.clone();

                let endTarget;
                if (camData.title === 'Exterior') {
                    // For exterior camera, always orbit model center
                    endTarget = new THREE.Vector3(0, 0, 0);
                } else {
                    // For other cameras, orbit the camera's look-at point
                    endTarget = new THREE.Vector3(0, 0, -1).applyQuaternion(targetQuat).add(targetPos);
                }

                this._camAnim = {
                    startPos,
                    endPos: targetPos,
                    startTarget,
                    endTarget,
                    startQuat,
                    endQuat: targetQuat,
                    startTime: Date.now(),
                    duration: 1000,
                };
            });

            container.appendChild(label);
            cameraControls.appendChild(container);
        });

        document.addEventListener("click", (e) => {
            const clickedInside = e.target.closest(".cam-btn-container");
            if (!clickedInside) {
                document.querySelectorAll(".cam-btn-container.active").forEach(el => {
                    el.classList.remove("active");
                });
            }
        });

        // Navigation buttons setup (merged here)
        const prevBtn = document.getElementById('prevHotspotBtn');
        const nextBtn = document.getElementById('nextHotspotBtn');
        const titleDisplay = document.getElementById('currentHotspotTitle');

        // Set initial text
        this.currentHotspotIndex = -1
        titleDisplay.textContent = "Click a hotspot or use arrows";

        const navigateToHotspot = (index) => {
            if (!this.allHotspots || this.allHotspots.length === 0) return;

            // If we're in title state (-1), start navigation from the requested direction
            if (this.currentHotspotIndex === -1) {
                if (index < -1) {
                    // Going backwards from title should go to last hotspot
                    this.currentHotspotIndex = this.allHotspots.length - 1;
                } else {
                    // Going forwards from title should go to first hotspot
                    this.currentHotspotIndex = 0;
                }
            } else {
                // Normal navigation - wrap around at boundaries
                if (index < 0) {
                    // Going backwards from first hotspot wraps to last
                    this.currentHotspotIndex = this.allHotspots.length - 1;
                } else if (index >= this.allHotspots.length) {
                    // Going forwards from last hotspot wraps to first
                    this.currentHotspotIndex = 0;
                } else {
                    this.currentHotspotIndex = index;
                }
            }

            // Show the hotspot
            const hotspotData = this.allHotspots[this.currentHotspotIndex];
            const hotspot = this.hotspots.find(h => h.data.node === hotspotData.node);
            if (hotspot) {
                this.handleHotspotClick(hotspot);
            }

            this.updateTitleDisplay();
        };

        prevBtn.addEventListener('click', () => {
            navigateToHotspot(this.currentHotspotIndex - 1);
        });

        nextBtn.addEventListener('click', () => {
            navigateToHotspot(this.currentHotspotIndex + 1);
        });

        // Mobile walk-through step nav bar buttons
        const mobileStepPrev = document.getElementById('mobileStepPrev');
        const mobileStepNext = document.getElementById('mobileStepNext');
        const mobileStepDone = document.getElementById('mobileStepDone');
        if (mobileStepPrev) mobileStepPrev.addEventListener('click', () => this.navigateWalkStep(-1));
        if (mobileStepNext) mobileStepNext.addEventListener('click', () => this.navigateWalkStep(1));
        if (mobileStepDone) mobileStepDone.addEventListener('click', () => this.showOverlay(1));

        hotspotDataList.forEach(hotspotData => {
            if (hotspotData.type === 'camera') return;

            let node = this.model.getObjectByName(hotspotData.node);
            if (!node) {
                this.model.traverse(child => {
                    if (!node && child.name.startsWith(hotspotData.node)) {
                        node = child;
                    }
                    if (child.isMesh) {
                        child.castShadow = true;
                    }
                });
            }

            if (!node) {
                console.warn(`❌ Could not find node for: ${hotspotData.node}`);
                return;
            }

            const worldPosition = new THREE.Vector3();
            node.getWorldPosition(worldPosition);

            const hotspotDiv = document.createElement('div');
            hotspotDiv.className = 'hotspot';
            hotspotDiv.style.backgroundImage = hotspotData.type === 'animation'
                ? `url('media/door_default.png')`
                : `url('${hotspotData.icon || 'media/Info_default.png'}')`;
            document.body.appendChild(hotspotDiv);

            const infoDiv = document.createElement('div');
            infoDiv.className = 'hotspot-info';
            if (hotspotData.mode) infoDiv.dataset.mode = hotspotData.mode;
            infoDiv.style.position = 'absolute';
            infoDiv.style.display = 'none'; // Start hidden
            infoDiv.style.left = '-9999px'; // Start off-screen to prevent flicker
            infoDiv.style.top = '-9999px';
            infoDiv.innerHTML = `
                <span class="mobile-handle-title">${hotspotData.title}</span>
                <button class="mobile-collapse-btn" aria-label="Collapse">▾</button>
                <img class="closeSpecIcon" src="media/Close.png" alt="Close" />
                <div class="text-scroll">
                    <div class="hotspot-title">${hotspotData.title}</div>
                    <div class="hotspot-description">${hotspotData.description}</div>
                </div>
                <div class="bottom-blocker"></div>
            `;
            document.body.appendChild(infoDiv);

            // Add step-nav arrows for walk-through mode (step hotspots only)
            if (hotspotData.step !== undefined) {
                const stepNav = document.createElement('div');
                stepNav.className = 'step-nav-arrows';
                stepNav.innerHTML = `
                    <button class="step-nav-btn step-prev" title="Previous step"><img src="media/arrow_left.svg" alt="Previous" style="width:14px;height:14px;"></button>
                    <span class="step-indicator"></span>
                    <button class="step-nav-btn step-next" title="Next step"><img src="media/arrow_right.svg" alt="Next" style="width:14px;height:14px;"></button>
                    <button class="step-done-btn">Done</button>
                `;
                infoDiv.appendChild(stepNav);
                stepNav.querySelector('.step-prev').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.navigateWalkStep(-1);
                });
                stepNav.querySelector('.step-next').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.navigateWalkStep(1);
                });
                stepNav.querySelector('.step-done-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showOverlay(1);
                });
            }

            // Add working close logic
            const closeBtn = infoDiv.querySelector('.closeSpecIcon');
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                infoDiv.style.display = 'none';
                infoDiv.classList.remove('active');

                // Deselect logic if you're using this.selectedHotspot
                if (this.selectedHotspot && this.selectedHotspot.info === infoDiv) {
                    this.selectedHotspot.element.classList.add('visited');
                    this.selectedHotspot.element.style.backgroundImage = this.selectedHotspot.data.type === 'animation'
                        ? `url('media/door_default.png')`
                        : `url('${this.selectedHotspot.data.icon || 'media/Info_default.png'}')`;
                    this.selectedHotspot = null;
                    // Clear outline effect
                    if (this.outlineEffect && this.outlineEffect.selection) {
                        this.outlineEffect.selection.clear();
                    }
                }
            });

            const collapseBtn = infoDiv.querySelector('.mobile-collapse-btn');
            if (collapseBtn) {
                collapseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const collapsed = infoDiv.classList.toggle('collapsed');
                    collapseBtn.textContent = collapsed ? '▴' : '▾';
                });
            }

            const geometry = new THREE.SphereGeometry(0.01);
            const material = new THREE.MeshBasicMaterial({ visible: false });
            const hotspotMesh = new THREE.Mesh(geometry, material);
            hotspotMesh.position.copy(worldPosition);
            this.scene.add(hotspotMesh);

            const hotspot = {
                element: hotspotDiv,
                info: infoDiv,
                data: hotspotData,
                mesh: hotspotMesh
            };

            this.hotspots.push(hotspot);

            if (!this.visitedHotspots) {
                this.visitedHotspots = new Set();
            }

            hotspotDiv.addEventListener('click', () => {
                this.handleHotspotClick(hotspot);
            });
            // Touch support for hotspot
            hotspotDiv.addEventListener('touchstart', (e) => {
                e.preventDefault();
                hotspotDiv.click();
            });

            hotspotDiv.addEventListener('mouseenter', () => {
                // Dismiss any other hover-only tooltip so only one shows at a time
                this.hotspots.forEach(h => {
                    if (h !== hotspot && h !== this.selectedHotspot) {
                        h.info.style.display = 'none';
                    }
                });

                if (this.selectedHotspot !== hotspot) {
                    hotspotDiv.style.backgroundImage = hotspotData.type === "animation"
                        ? `url('media/door_selected.png')`
                        : `url('${hotspotData.iconSelected || hotspotData.icon || 'media/Info_Selected.png'}')`;
                }

                infoDiv.style.display = 'block';
            });

            hotspotDiv.addEventListener('mouseleave', () => {
                if (this.selectedHotspot === hotspot) {
                    hotspotDiv.style.backgroundImage = hotspotData.type === "animation"
                        ? `url('media/door_selected.png')`
                        : `url('${hotspotData.icon || 'media/Info_Selected.png'}')`;
                } else {
                    infoDiv.style.display = 'none';
                    hotspotDiv.style.backgroundImage = hotspotData.type === "animation"
                        ? `url('media/door_default.png')`
                        : `url('${hotspotData.icon || 'media/Info_default.png'}')`;
                }
            });
        });
        // === Initialize door states for animation-type hotspots (Base + Base_open) ===
        // Start all door/animation hotspots CLOSED
        this.allHotspots
            .filter(h => h.type === 'animation')
            .forEach(h => {
                const base = (h.node || '').replace(/(\.|_)open$/i, ''); // "XX_Y_open" -> "XX_Y"
                const openNode = this.model.getObjectByName(`${base}_open`) || this.model.getObjectByName(`${base}.open`);
                const closeNode = this.model.getObjectByName(base) || this.model.getObjectByName(`${base}.close`) || this.model.getObjectByName(`${base}_close`);
                if (openNode) openNode.visible = false;
                if (closeNode) closeNode.visible = true;
            });



        this.setupHazardFilter();

        // Ensure hotspots are visible by default after all are created
        this.updateHotspotPositions();

    }

    setupHazardFilter() {
        const desktopPanel = document.getElementById('hazardFilter');
        if (!desktopPanel) return;

        const seen = new Map();
        this.allHotspotsAll
            .filter(h => h.mode === 'safety')
            .forEach(h => { if (!seen.has(h.title)) seen.set(h.title, h.icon); });

        const buildButtons = (container) => {
            container.innerHTML = '';
            const clearBtn = document.createElement('button');
            clearBtn.className = 'hazard-filter-btn hazard-filter-clear active';
            clearBtn.textContent = 'All Hazards';
            clearBtn.addEventListener('click', () => this.clearHazardFilter());
            container.appendChild(clearBtn);

            seen.forEach((icon, title) => {
                const btn = document.createElement('button');
                btn.className = 'hazard-filter-btn';
                btn.dataset.hazard = title;
                const img = document.createElement('img');
                img.src = icon; img.alt = title;
                const label = document.createElement('span');
                label.textContent = title;
                btn.appendChild(img);
                btn.appendChild(label);
                btn.addEventListener('click', () => this.setHazardFilter(title));
                container.appendChild(btn);
            });
        };

        buildButtons(desktopPanel);

        if (IS_MOBILE) {
            const mobilePanel = document.getElementById('mobileHazardPanel');
            if (mobilePanel) buildButtons(mobilePanel);

            const toggle = document.getElementById('mobileHazardToggle');
            const mobilePanel2 = document.getElementById('mobileHazardPanel');
            const overlay = document.getElementById('mobileHazardOverlay');
            if (toggle && !toggle._setupDone) {
                toggle._setupDone = true;
                const openPanel = () => { mobilePanel2.classList.add('open'); overlay.classList.add('open'); toggle.textContent = '×'; };
                const closePanel = () => { mobilePanel2.classList.remove('open'); overlay.classList.remove('open'); toggle.textContent = '+'; };
                toggle.addEventListener('click', () => mobilePanel2.classList.contains('open') ? closePanel() : openPanel());
                overlay.addEventListener('click', closePanel);
                this._closeMobileHazardPanel = closePanel;
            }
        }
    }

    setHazardFilter(title) {
        this.activeHazardFilter = title;
        this.allHotspots = this.allHotspotsAll.filter(h => h.mode === 'safety' && h.title === title);
        this.currentHotspotIndex = -1;
        const titleDisplay = document.getElementById('currentHotspotTitle');
        if (titleDisplay) titleDisplay.textContent = 'Click a hotspot or use arrows';

        document.querySelectorAll('.hazard-filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.hazard === title);
        });
        if (IS_MOBILE && this._closeMobileHazardPanel) this._closeMobileHazardPanel();

        if (this.selectedHotspot && this.selectedHotspot.data.title !== title) {
            this.selectedHotspot.element.classList.add('visited');
            this.selectedHotspot.element.style.backgroundImage = `url('${this.selectedHotspot.data.icon || 'media/Info_default.png'}')`;
            this.selectedHotspot.info.style.display = 'none';
            this.selectedHotspot.info.classList.remove('active');
            if (this.outlineEffect && this.outlineEffect.selection) {
                this.outlineEffect.selection.clear();
            }
            this.selectedHotspot = null;
        }

        // Fly camera to first hotspot of this type and open its info panel
        const firstMatch = this.hotspots.find(h => h.data.title === title && h.data.mode === 'safety');
        if (firstMatch) {
            this.handleHotspotClick(firstMatch);
        }

        this.needsUpdate = true;
    }

    clearHazardFilter() {
        this.activeHazardFilter = null;
        this.allHotspots = this.allHotspotsAll.filter(h => h.mode === 'safety');
        this.currentHotspotIndex = -1;
        const titleDisplay = document.getElementById('currentHotspotTitle');
        if (titleDisplay) titleDisplay.textContent = 'Click a hotspot or use arrows';

        document.querySelectorAll('.hazard-filter-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.hazard-filter-clear').forEach(btn => btn.classList.add('active'));
        if (IS_MOBILE && this._closeMobileHazardPanel) this._closeMobileHazardPanel();

        if (this.selectedHotspot) {
            this.selectedHotspot.element.classList.add('visited');
            this.selectedHotspot.element.style.backgroundImage = `url('${this.selectedHotspot.data.icon || 'media/Info_default.png'}')`;
            this.selectedHotspot.info.style.display = 'none';
            this.selectedHotspot.info.classList.remove('active');
            if (this.outlineEffect && this.outlineEffect.selection) {
                this.outlineEffect.selection.clear();
            }
            this.selectedHotspot = null;
        }

        this.animateCameraReset();
        this.needsUpdate = true;
    }

    updateTitleDisplay() {
        const titleDisplay = document.getElementById('currentHotspotTitle');
        if (this.allHotspots && this.allHotspots.length > 0) {
            titleDisplay.innerHTML = `<span>${this.allHotspots[this.currentHotspotIndex].title}</span>`;
        }
    }

    // switchToNamedCamera(cameraName) {
    //     const camNode = this.namedCameras?.[cameraName];
    //     if (!camNode) {
    //         console.warn(`Camera '${cameraName}' not found.`);
    //         return;
    //     }

    //     const startPos = this.camera.position.clone();
    //     const startQuat = this.camera.quaternion.clone();
    //     const targetPos = camNode.position.clone();
    //     const targetQuat = camNode.quaternion.clone();

    //     const startTime = Date.now();
    //     const duration = 1500;

    //     const animateSwitch = () => {
    //         const elapsed = Date.now() - startTime;
    //         const t = Math.min(elapsed / duration, 1);
    //         const ease = 1 - Math.pow(1 - t, 4);

    //         this.camera.position.lerpVectors(startPos, targetPos, ease);
    //         this.camera.quaternion.slerpQuaternions(startQuat, targetQuat, ease);

    //         this.controls.target.set(0, 0, 0); // optionally modify
    //         this.controls.update();

    //         if (t < 1) requestAnimationFrame(animateSwitch);
    //     };

    //     animateSwitch();
    // }

    applyMaterialVariant(variantName) {
        if (!this.gltf || !variantName) return;

        const variantDefs = this.gltf.parser.json.extensions?.KHR_materials_variants?.variants;
        const variantIndex = variantDefs?.findIndex(v => v.name === variantName);

        if (variantIndex === -1 || variantIndex === undefined) {
            console.warn('❌ Variant not found:', variantName);
            return;
        }

        this.model.traverse((object) => {
            const ext = object.userData?.gltfExtensions?.KHR_materials_variants;
            if (!object.isMesh || !ext || !ext.mappings) return;

            const mapping = ext.mappings.find(m => m.variants.includes(variantIndex));
            if (mapping && mapping.material !== undefined) {
                this.gltf.parser.getDependency('material', mapping.material).then((newMat) => {
                    object.material = newMat;
                    object.material.needsUpdate = true;
                    this.needsUpdate = true;
                });
            }
        });

        console.log(`🎨 Applied variant: ${variantName}`);
    }

    moveToHotspotView(hotspot) {
        const camNodeName = hotspot.data.camera || `Cam_${hotspot.data.node}`;
        const camNode = this.model.getObjectByName(camNodeName);
        const hotspotNode = this.model.getObjectByName(hotspot.data.node);
        if (camNode && camNode.isObject3D && hotspotNode) {
            const endPos = new THREE.Vector3();
            camNode.getWorldPosition(endPos);
            const endTarget = new THREE.Vector3();
            hotspotNode.getWorldPosition(endTarget);
            const startPos = this.camera.position.clone();
            const startTarget = this.controls.target.clone();
            // Animate both camera position and controls.target (orbit center)
            const duration = 1500;
            const startTime = Date.now();
            const animate = () => {
                const elapsed = Date.now() - startTime;
                const t = Math.min(elapsed / duration, 1);
                const ease = 1 - Math.pow(1 - t, 4);
                this.camera.position.lerpVectors(startPos, endPos, ease);
                this.controls.target.lerpVectors(startTarget, endTarget, ease);
                this.controls.update();
                this.needsUpdate = true;
                if (t < 1) {
                    requestAnimationFrame(animate);
                }
            };
            animate();
        } else {
            console.warn(`❌ No camera node or hotspot node found for: ${camNodeName}`);
        }
    }

    // moveCameraTo(positionArray, quaternionArray) {
    //     const startPos = this.camera.position.clone();
    //     const startQuat = this.camera.quaternion.clone();

    //     const targetPos = new THREE.Vector3().fromArray(positionArray);
    //     const targetQuat = new THREE.Quaternion().fromArray(quaternionArray);

    //     const startTarget = this.controls.target.clone();
    //     const endTarget = new THREE.Vector3(0, 0, -1).applyQuaternion(targetQuat).add(targetPos);

    //     const duration = 1000;
    //     const startTime = Date.now();

    //     const animate = () => {
    //         const elapsed = Date.now() - startTime;
    //         const t = Math.min(elapsed / duration, 1);
    //         const ease = 1 - Math.pow(1 - t, 4);

    //         this.camera.position.lerpVectors(startPos, targetPos, ease);
    //         this.camera.quaternion.slerpQuaternions(startQuat, targetQuat, ease);
    //         this.controls.target.lerpVectors(startTarget, endTarget, ease);
    //         this.controls.update();

    //         if (t < 1) requestAnimationFrame(animate);
    //     };

    //     animate();
    // }

    setupPostprocessing() {
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));

        // Optimized outline effect
        this.outlineEffect = new OutlineEffect(this.scene, this.camera, {
            selection: [],
            blendFunction: BlendFunction.ALPHA,
            edgeStrength: 2,
            pulseSpeed: 0.0,
            visibleEdgeColor: new THREE.Color('#2873F5'),
            hiddenEdgeColor: new THREE.Color('#2873F5'),
            multisampling: 2, // Reduced from 4
            resolution: {
                width: window.innerWidth / 2,
                height: window.innerHeight / 2
            },
            xRay: false,
            kernelSize: 1,
            blur: true,
            edgeGlow: 0.0,
            usePatternTexture: false
        });

        const smaaEffect = new SMAAEffect();
        const effectPass = new EffectPass(this.camera, this.outlineEffect, smaaEffect);
        effectPass.renderToScreen = true;
        this.composer.addPass(effectPass);
    }

    // Optimized animation loop
    animate() {
        requestAnimationFrame(this.animate.bind(this));

        // Advance camera animation (single source of truth — no separate rAF loops)
        if (this._camAnim) {
            const a = this._camAnim;
            const elapsed = Date.now() - a.startTime;
            const t = Math.min(elapsed / a.duration, 1);
            const ease = 1 - Math.pow(1 - t, 4);
            this.camera.position.lerpVectors(a.startPos, a.endPos, ease);
            if (a.startQuat && a.endQuat) {
                this.camera.quaternion.slerpQuaternions(a.startQuat, a.endQuat, ease);
            }
            this.controls.target.lerpVectors(a.startTarget, a.endTarget, ease);
            this.needsUpdate = true;
            if (t >= 1) {
                this._camAnim = null;
                // Force raycast on next frame so hotspots appear immediately at landing position
                this.raycastFrameCount = this.raycastInterval;
            }
        }

        // Apply damping — fires 'change' event each frame while settling,
        // which sets this.cameraChanged = true via the listener below
        this.controls.update();

        // FPS cap — gate renders to targetFPS regardless of display refresh rate
        const now = performance.now();
        if (now - this._lastFrameTime < this._frameBudget) return;
        this._lastFrameTime = now;

        const shouldRefresh = this.cameraChanged || this.needsUpdate;
        if (shouldRefresh) {
            this.updateHotspotPositions();
            // Skip composer during camera animation — SMAA+outline at full rAF rate kills GPU mid-flight
            const hasOutline = !this._camAnim && this.outlineEffect?.selection.size > 0;
            if (hasOutline) {
                this.composer.render();
            } else {
                this.renderer.render(this.scene, this.camera);
            }
            this.cameraChanged = false;
            this.needsUpdate = false;
        }

        // Stats inside frame budget so it measures actual render rate, not rAF rate
        if (!IS_MOBILE && this.stats) {
            this.stats.update();
        }
    }

    animateOutlineEdgeStrength(start, end, duration, onComplete) {
        if (!this.outlineEffect) return;
        const startTime = performance.now();
        const animate = () => {
            const now = performance.now();
            const t = Math.min((now - startTime) / duration, 1);
            this.outlineEffect.edgeStrength = start + (end - start) * t;
            this.needsUpdate = true;
            if (t < 1) {
                requestAnimationFrame(animate);
            } else {
                this.outlineEffect.edgeStrength = end;
                if (onComplete) onComplete();
            }
        };
        animate();
    }

    updateHotspotPositions() {
        if (!this.hotspots) return;

        // Increment frame counter for raycast throttling
        this.raycastFrameCount++;
        const shouldRaycast = this.raycastFrameCount >= this.raycastInterval;
        if (shouldRaycast) this.raycastFrameCount = 0;

        // Cache once per update — avoids repeated DOM reads inside the loop
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;
        const isMobileView = viewW < 600 || viewH < 400;

        this.hotspots.forEach((hotspot) => {
            const worldPosition = new THREE.Vector3();
            hotspot.mesh.getWorldPosition(worldPosition);

            // Project to screen coordinates
            const screenPosition = worldPosition.clone().project(this.camera);
            const isBehindCamera = screenPosition.z > 1;
            const isInView = screenPosition.x >= -1 && screenPosition.x <= 1 &&
                screenPosition.y >= -1 && screenPosition.y <= 1;

            const x = (screenPosition.x + 1) * viewW / 2;
            const y = (-screenPosition.y + 1) * viewH / 2;

            // During camera animation or LOTO mode, skip raycast.
            // LOTO lockout points are on all sides of the machine — occlusion from the default
            // angle incorrectly hides most of them. isBehindCamera/isInView are sufficient.
            let isOccluded;
            const skipOcclusion = this._camAnim || this.activeMode === 'LOTO';
            if (skipOcclusion) {
                isOccluded = false;
            } else if (shouldRaycast) {
                const direction = worldPosition.clone().sub(this.camera.position).normalize();
                this.raycaster.set(this.camera.position, direction);
                const intersects = this.raycaster.intersectObjects(this.interactiveMeshes, true)
                    .filter(hit => hit.object.name !== 'SM_PackingMachine_v03_M_Glass_0');
                const distanceToHotspot = this.camera.position.distanceTo(worldPosition);
                isOccluded = intersects.length > 0 && intersects[0].distance + 0.1 < distanceToHotspot;
                this.lastOcclusionResults.set(hotspot, isOccluded);
            } else {
                isOccluded = this.lastOcclusionResults.get(hotspot) ?? false;
            }

            // Update visibility
            let modeMatch;
            if (this.walkThroughMode) {
                modeMatch = hotspot.data.mode === 'LOTO' && hotspot.data.step !== undefined;
            } else {
                modeMatch = !!this.activeMode && hotspot.data.mode === this.activeMode;
            }
            const hazardFilterMatch = !(this.activeMode === 'safety' && this.activeHazardFilter)
                || hotspot.data.title === this.activeHazardFilter;
            const shouldShow = modeMatch && hazardFilterMatch && !(isBehindCamera || !isInView || isOccluded);

            hotspot.element.style.opacity = shouldShow ? '1' : '0';
            hotspot.element.style.pointerEvents = shouldShow ? 'auto' : 'none';

            // JS-side cache avoids layout-forcing DOM reads (parseInt on style props)
            if (Math.abs((hotspot._lastX ?? Infinity) - x) > 1 || Math.abs((hotspot._lastY ?? Infinity) - y) > 1) {
                hotspot.element.style.left = `${x}px`;
                hotspot.element.style.top = `${y}px`;
                hotspot._lastX = x;
                hotspot._lastY = y;
            }

            // Handle info panel
            const showInfo = shouldShow && (hotspot === this.selectedHotspot || hotspot.element.matches(':hover'));
            hotspot.info.style.display = showInfo ? 'block' : 'none';

            const infoLeft = x + 20;
            if (isMobileView) {
                if (hotspot === this.selectedHotspot) {
                    hotspot.info.classList.add('mobile-fixed');
                    hotspot.info.style.left = '';
                    hotspot.info.style.top = '';
                    hotspot._lastInfoLeft = null;
                    hotspot._lastInfoTop = null;
                } else {
                    hotspot.info.classList.remove('mobile-fixed');
                    if (hotspot._lastInfoLeft !== infoLeft) { hotspot.info.style.left = `${infoLeft}px`; hotspot._lastInfoLeft = infoLeft; }
                    if (hotspot._lastInfoTop !== y) { hotspot.info.style.top = `${y}px`; hotspot._lastInfoTop = y; }
                }
            } else {
                hotspot.info.classList.remove('mobile-fixed');
                if (hotspot._lastInfoLeft !== infoLeft) { hotspot.info.style.left = `${infoLeft}px`; hotspot._lastInfoLeft = infoLeft; }
                if (hotspot._lastInfoTop !== y) { hotspot.info.style.top = `${y}px`; hotspot._lastInfoTop = y; }
            }
        });
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();

        const pixelRatio = IS_MOBILE ? 1 : Math.min(window.devicePixelRatio, 2);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(pixelRatio);

        // Update composer if exists
        if (this.composer) {
            this.composer.setSize(window.innerWidth, window.innerHeight);

            // Update outline effect resolution
            if (this.outlineEffect && this.outlineEffect.resolution) {
                this.outlineEffect.resolution.width = window.innerWidth * pixelRatio;
                this.outlineEffect.resolution.height = window.innerHeight * pixelRatio;
                this.outlineEffect.setSize(window.innerWidth * pixelRatio, window.innerHeight * pixelRatio);
            }
        }

        // Canvas buffer is cleared on resize — force a re-render
        this.needsUpdate = true;
    }

    setupFullscreenButton() {
        const button = document.getElementById('fullscreenBtn');
        if (!button) {
            console.warn('Fullscreen button not found');
            return;
        }

        const icon = button.querySelector('img');

        button.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(err => {
                    console.error('Error attempting to enable fullscreen:', err);
                });
            } else {
                document.exitFullscreen();
            }
        });

        // Update button icon on fullscreen state change
        document.addEventListener('fullscreenchange', () => {
            if (icon) {
                icon.src = document.fullscreenElement
                    ? 'media/Fullscreen_acitve.svg'
                    : 'media/Fullscreen_default.svg';
            }
        });

    }

    setupResetButton() {
        const button = document.getElementById('resetBtn');
        if (!button) {
            console.warn('Reset button not found');
            return;
        }

        button.addEventListener('click', () => {
            console.log('🔄 Resetting view...');

            // Reset camera to initial position with smooth animation
            if (this.initialCameraPosition && this.initialCameraTarget) {
                const targetPos = this.initialCameraPosition.clone();
                const targetTarget = this.initialCameraTarget.clone();
                const startPos = this.camera.position.clone();
                const startTarget = this.controls.target.clone();
                const duration = 2000;
                const startTime = Date.now();

                const animateReset = () => {
                    const elapsed = Date.now() - startTime;
                    const t = Math.min(elapsed / duration, 1);
                    const ease = 1 - Math.pow(1 - t, 4);
                    this.camera.position.lerpVectors(startPos, targetPos, ease);
                    this.controls.target.lerpVectors(startTarget, targetTarget, ease);
                    this.controls.update();
                    this.needsUpdate = true;
                    if (t < 1) {
                        requestAnimationFrame(animateReset);
                    }
                };
                animateReset();
            }

            // Clear any selected hotspot
            if (this.selectedHotspot) {
                this.selectedHotspot.element.classList.add('visited');
                this.selectedHotspot.element.style.backgroundImage =
                    this.selectedHotspot.data.type === 'animation'
                        ? `url('media/door_default.png')`
                        : `url('${this.selectedHotspot.data.icon || 'media/Info_default.png'}')`;
                this.selectedHotspot.info.style.display = 'none';
                this.selectedHotspot.info.classList.remove('active');
                this.selectedHotspot = null;
            }

            // Clear outline effect
            if (this.outlineEffect && this.outlineEffect.selection) {
                this.outlineEffect.selection.clear();
            }

            // Reset navigation state
            this.currentHotspotIndex = -1;
            const titleDisplay = document.getElementById('currentHotspotTitle');
            if (titleDisplay) {
                titleDisplay.textContent = "Click a hotspot or use arrows";
            }

            // Clear camera button states
            document.querySelectorAll(".cam-btn-container.active").forEach(el => {
                el.classList.remove("active");
            });

            // Reset material variant if method exists
            if (typeof this.applyMaterialVariant === 'function') {
                this.applyMaterialVariant('00_Default');
            }

        });
    }
    setupPDFButton() {
        const button = document.getElementById('pdfBtn');
        const icon = document.getElementById('pdfIcon');
        if (!button) return;

        button.addEventListener('click', () => {
            // Replace with the path to your PDF
            const pdfUrl = 'media/65P10AR_Rev02_12-24.pdf';

            // Open in a new tab
            window.open(pdfUrl, '_blank');
        });
        // button.addEventListener('mouseenter', () => {
        //     icon.src = 'media/PDF_active.svg';
        // });

        button.addEventListener('mouseleave', () => {
            icon.src = 'media/PDF_default.svg';
        });
    }
    setupModeFilter() {
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setModeFilter(btn.dataset.mode);
            });
        });
    }

    setModeFilter(mode) {
        this.walkThroughMode = false;
        this.activeMode = this.activeMode === mode ? null : mode;
        this.activeHazardFilter = null;

        this.allHotspots = this.activeMode
            ? this.allHotspotsAll.filter(h => h.mode === this.activeMode)
            : [...this.allHotspotsAll];

        const isSafety = this.activeMode === 'safety';
        const hazardPanel = document.getElementById('hazardFilter');
        if (hazardPanel) {
            hazardPanel.style.display = !IS_MOBILE && isSafety ? 'flex' : 'none';
            hazardPanel.querySelectorAll('.hazard-filter-btn').forEach(btn => btn.classList.remove('active'));
            const clearBtn = hazardPanel.querySelector('.hazard-filter-clear');
            if (clearBtn) clearBtn.classList.add('active');
        }
        if (IS_MOBILE) {
            const mobileHazardToggle = document.getElementById('mobileHazardToggle');
            if (mobileHazardToggle) mobileHazardToggle.style.display = isSafety ? 'flex' : 'none';
            if (!isSafety && this._closeMobileHazardPanel) this._closeMobileHazardPanel();
        }

        this.currentHotspotIndex = -1;
        const titleDisplay = document.getElementById('currentHotspotTitle');
        if (titleDisplay) titleDisplay.textContent = 'Click a hotspot or use arrows';

        if (this.selectedHotspot) {
            this.selectedHotspot.info.style.display = 'none';
            this.selectedHotspot.info.classList.remove('active');
            if (this.outlineEffect && this.outlineEffect.selection) {
                this.outlineEffect.selection.clear();
            }
            this.selectedHotspot = null;
        }

        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === this.activeMode);
        });

        this.animateCameraReset();
        this.clearVisitedState();
        if (this.activeMode === 'LOTO') this.setModeLabel('Lockout/Tagout', 'Explore');
        else if (isSafety) this.setModeLabel('Safety Map');
        else this.setModeLabel(null);
        const navUI = document.querySelector('.navigation-ui');
        if (navUI) navUI.style.display = '';

        this.needsUpdate = true;
    }

    setupModeOverlay() {
        document.getElementById('overlayLOTOBtn').addEventListener('click', () => {
            document.getElementById('overlayPanel1').style.display = 'none';
            document.getElementById('overlayPanel2').style.display = 'flex';
        });

        document.getElementById('overlaySafetyBtn').addEventListener('click', () => {
            this.activeMode = 'safety';
            this.walkThroughMode = false;
            this.activeHazardFilter = null;
            this.allHotspots = this.allHotspotsAll.filter(h => h.mode === 'safety');
            this.currentHotspotIndex = -1;
            const titleDisplay = document.getElementById('currentHotspotTitle');
            if (titleDisplay) titleDisplay.textContent = 'Click a hotspot or use arrows';
            document.querySelectorAll('.mode-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === 'safety');
            });
            this.animateCameraReset();
            this.clearVisitedState();
            this.setModeLabel('Safety Map');
            const navUI = document.querySelector('.navigation-ui');
            if (navUI) navUI.style.display = '';
            const hazardPanel = document.getElementById('hazardFilter');
            if (hazardPanel) {
                hazardPanel.style.display = IS_MOBILE ? 'none' : 'flex';
                hazardPanel.querySelectorAll('.hazard-filter-btn').forEach(btn => btn.classList.remove('active'));
                const clearBtn = hazardPanel.querySelector('.hazard-filter-clear');
                if (clearBtn) clearBtn.classList.add('active');
            }
            if (IS_MOBILE) {
                const mobileHazardToggle = document.getElementById('mobileHazardToggle');
                if (mobileHazardToggle) mobileHazardToggle.style.display = 'flex';
            }
            this.needsUpdate = true;
            this.hideOverlay();
        });

        document.getElementById('overlayWalkBtn').addEventListener('click', () => {
            this.startWalkThrough();
        });

        document.getElementById('overlayExploreBtn').addEventListener('click', () => {
            this.activeMode = 'LOTO';
            this.walkThroughMode = false;
            this.allHotspots = this.allHotspotsAll.filter(h => h.mode === 'LOTO');
            this.currentHotspotIndex = -1;
            const titleDisplay = document.getElementById('currentHotspotTitle');
            if (titleDisplay) titleDisplay.textContent = 'Click a hotspot or use arrows';
            document.querySelectorAll('.mode-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === 'LOTO');
            });
            this.animateCameraReset();
            this.clearVisitedState();
            this.setModeLabel('Lockout/Tagout', 'Explore');
            const navUI2 = document.querySelector('.navigation-ui');
            if (navUI2) navUI2.style.display = '';
            this.needsUpdate = true;
            this.hideOverlay();
        });

        document.getElementById('overlayBackBtn').addEventListener('click', () => {
            document.getElementById('overlayPanel2').style.display = 'none';
            document.getElementById('overlayPanel1').style.display = 'flex';
        });

        document.getElementById('modeBtn').addEventListener('click', () => {
            this.showOverlay(1);
        });

        document.getElementById('overlayCloseBtn').addEventListener('click', () => {
            this.hideOverlay();
        });
    }

    showOverlay(panel) {
        // Deselect any open hotspot
        if (this.selectedHotspot) {
            this.selectedHotspot.info.style.display = 'none';
            this.selectedHotspot.info.classList.remove('active');
            this.selectedHotspot = null;
        }
        if (this.outlineEffect && this.outlineEffect.selection) {
            this.outlineEffect.selection.clear();
        }
        // Hide all step navs
        document.querySelectorAll('.step-nav-arrows').forEach(nav => {
            nav.style.display = 'none';
        });
        if (IS_MOBILE) {
            const msn = document.getElementById('mobileStepNav');
            if (msn) msn.style.display = 'none';
            const mobileHazardToggle = document.getElementById('mobileHazardToggle');
            if (mobileHazardToggle) mobileHazardToggle.style.display = 'none';
            if (this._closeMobileHazardPanel) this._closeMobileHazardPanel();
        }
        // Reset mode state
        this.activeMode = null;
        this.walkThroughMode = false;
        this.activeHazardFilter = null;
        const hazardPanel = document.getElementById('hazardFilter');
        if (hazardPanel) hazardPanel.style.display = 'none';
        this.allHotspots = [...this.allHotspotsAll];
        this.currentHotspotIndex = -1;
        const titleDisplay = document.getElementById('currentHotspotTitle');
        if (titleDisplay) titleDisplay.textContent = 'Click a hotspot or use arrows';
        document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
        this.needsUpdate = true;

        // Reset camera and visited state
        this.animateCameraReset();
        this.clearVisitedState();
        this.setModeLabel(null);

        // Hide bottom navigation while overlay is visible
        const navUI = document.querySelector('.navigation-ui');
        if (navUI) navUI.style.display = 'none';

        // Update mode button icon to active
        const modeIcon = document.getElementById('modeIcon');
        if (modeIcon) modeIcon.src = 'media/Grid_active.svg';

        // Show correct panel
        const p1 = document.getElementById('overlayPanel1');
        const p2 = document.getElementById('overlayPanel2');
        if (p1) p1.style.display = panel === 1 ? 'flex' : 'none';
        if (p2) p2.style.display = panel === 2 ? 'flex' : 'none';
        document.getElementById('modeOverlay').style.display = 'flex';
    }

    hideOverlay() {
        document.getElementById('modeOverlay').style.display = 'none';
        const modeIcon = document.getElementById('modeIcon');
        if (modeIcon) modeIcon.src = 'media/Grid_default.svg';
    }

    startWalkThrough() {
        this.walkThroughMode = true;
        this.activeMode = 'LOTO';
        this.walkThroughSteps = this.allHotspotsAll
            .filter(h => h.mode === 'LOTO' && h.step !== undefined)
            .sort((a, b) => a.step - b.step);
        this.allHotspots = [...this.walkThroughSteps];
        this.currentWalkStep = 0;
        this.currentHotspotIndex = 0;
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === 'LOTO');
        });
        this.clearVisitedState();
        this.setModeLabel('Lockout/Tagout', 'Walk-Through');
        const navUI = document.querySelector('.navigation-ui');
        if (navUI) navUI.style.display = 'none';
        if (IS_MOBILE) {
            const mobileHazardToggle = document.getElementById('mobileHazardToggle');
            if (mobileHazardToggle) mobileHazardToggle.style.display = 'none';
        }
        this.hideOverlay();
        this.goToWalkStep(0);
    }

    goToWalkStep(index) {
        if (index < 0 || index >= this.walkThroughSteps.length) return;
        this.currentWalkStep = index;
        this.currentHotspotIndex = index;
        const stepData = this.walkThroughSteps[index];
        const hotspot = this.hotspots.find(h => h.data.node === stepData.node);
        if (hotspot) this.handleHotspotClick(hotspot);
    }

    navigateWalkStep(dir) {
        this.goToWalkStep(this.currentWalkStep + dir);
    }

    updateStepNavDisplay() {
        document.querySelectorAll('.step-nav-arrows').forEach(nav => nav.style.display = 'none');

        if (!this.walkThroughMode || !this.selectedHotspot || this.selectedHotspot.data.step === undefined) {
            if (IS_MOBILE) {
                const msn = document.getElementById('mobileStepNav');
                if (msn) msn.style.display = 'none';
            }
            return;
        }

        const isLastStep = this.currentWalkStep === this.walkThroughSteps.length - 1;
        const stepText = `Step ${this.selectedHotspot.data.step} of ${this.walkThroughSteps.length}`;

        if (IS_MOBILE) {
            const msn = document.getElementById('mobileStepNav');
            if (msn) msn.style.display = 'flex';
            const prev = document.getElementById('mobileStepPrev');
            const next = document.getElementById('mobileStepNext');
            const ind = document.getElementById('mobileStepIndicator');
            const done = document.getElementById('mobileStepDone');
            if (prev) { prev.style.opacity = this.currentWalkStep > 0 ? '' : '0'; prev.style.pointerEvents = this.currentWalkStep > 0 ? '' : 'none'; }
            if (next) { next.style.opacity = !isLastStep ? '' : '0'; next.style.pointerEvents = !isLastStep ? '' : 'none'; }
            if (ind) ind.textContent = stepText;
            if (done) done.style.display = isLastStep ? 'flex' : 'none';
            return;
        }

        // Desktop: update in-panel step nav
        const stepNav = this.selectedHotspot.info.querySelector('.step-nav-arrows');
        if (!stepNav) return;
        stepNav.style.display = 'flex';
        const prevBtn = stepNav.querySelector('.step-prev');
        const nextBtn = stepNav.querySelector('.step-next');
        const indicator = stepNav.querySelector('.step-indicator');
        prevBtn.style.opacity = this.currentWalkStep > 0 ? '' : '0';
        prevBtn.style.pointerEvents = this.currentWalkStep > 0 ? '' : 'none';
        nextBtn.style.opacity = !isLastStep ? '' : '0';
        nextBtn.style.pointerEvents = !isLastStep ? '' : 'none';
        indicator.textContent = stepText;
        const doneBtn = stepNav.querySelector('.step-done-btn');
        if (doneBtn) doneBtn.style.display = isLastStep ? 'flex' : 'none';
    }

    setModeLabel(text, subtitle = null) {
        const label = document.getElementById('modeLabel');
        if (!label) return;
        if (text) {
            label.innerHTML = `<span class="mode-label-title">${text}</span>${subtitle ? `<span class="mode-label-sub">${subtitle}</span>` : ''}`;
            label.style.display = '';
        } else {
            label.style.display = 'none';
        }
    }

    animateCameraReset() {
        if (!this.initialCameraPosition) return;
        this._camAnim = {
            startPos: this.camera.position.clone(),
            endPos: this.initialCameraPosition.clone(),
            startTarget: this.controls.target.clone(),
            endTarget: this.initialCameraTarget.clone(),
            startQuat: null,
            endQuat: null,
            startTime: Date.now(),
            duration: 2000,
        };
    }

    clearVisitedState() {
        this.visitedHotspots.clear();
        this.hotspots.forEach(h => {
            if (h.element) {
                h.element.classList.remove('visited');
                h.element.style.backgroundImage = `url('${h.data.icon || 'media/Info_default.png'}')`;
            }
        });
    }

    setupTechSpecToggle() {
        const button = document.getElementById('techSpecBtn');
        const icon = document.getElementById('techSpecIcon');
        const modal = document.getElementById('specModal');
        const content = document.getElementById('specContent');
        const closeIcon = document.getElementById('closeSpecIcon');
        if (!button) return;

        let isVisible = false;

        // Recursive renderer for nested spec objects
        const renderSpecs = (obj, container, level = 0) => {
            for (const [key, value] of Object.entries(obj)) {
                // Handle arrays (like Power Module, Electrical, etc.)
                if (Array.isArray(value)) {
                    const section = document.createElement(level === 0 ? 'h2' : 'h3');
                    section.className = 'spec-section';
                    section.textContent = key;
                    container.appendChild(section);

                    value.forEach(line => {
                        const item = document.createElement('div');
                        item.className = 'spec-item';

                        const val = document.createElement('span');
                        val.className = 'spec-value';
                        val.textContent = line;

                        item.appendChild(val);
                        container.appendChild(item);
                    });

                    // Handle nested objects (like Models > Standard)
                } else if (typeof value === 'object' && value !== null) {
                    const section = document.createElement(level === 0 ? 'h2' : 'h3');
                    section.className = 'spec-section';
                    section.textContent = key;
                    container.appendChild(section);

                    renderSpecs(value, container, level + 1);

                    // Handle single key-value entries
                } else {
                    const item = document.createElement('div');
                    item.className = 'spec-item';

                    const label = document.createElement('span');
                    label.className = 'spec-label';
                    label.textContent = `${key}: `;

                    const val = document.createElement('span');
                    val.className = 'spec-value';
                    val.textContent = value;

                    item.appendChild(label);
                    item.appendChild(val);
                    container.appendChild(item);
                }
            }
        };


        const showSpecs = async () => {
            try {
                const response = await fetch('specs.json');
                if (!response.ok) throw new Error('Failed to load specs.json');

                const specs = await response.json();
                content.innerHTML = '';
                renderSpecs(specs, content);

                modal.style.display = 'block';
                icon.src = 'media/Spec_active.svg';
                isVisible = true;
            } catch (err) {
                content.innerHTML = '<p>Error loading specs.</p>';
                modal.style.display = 'block';
                icon.src = 'media/Spec_active.svg';
                isVisible = true;
                console.error(err);
            }
        };

        const hideSpecs = () => {
            modal.style.display = 'none';
            icon.src = 'media/Spec_default.svg';
            isVisible = false;
        };

        button.addEventListener('click', () => {
            if (isVisible) {
                hideSpecs();
            } else {
                showSpecs();
            }
        });

        closeIcon.addEventListener('click', hideSpecs);

        button.addEventListener('mouseenter', () => {
            if (!isVisible) icon.src = 'media/Spec_active.svg';
        });

        button.addEventListener('mouseleave', () => {
            if (!isVisible) icon.src = 'media/Spec_default.svg';
        });
    }
}

// Initialize the application
new HotspotManager();