import React, { useState, useEffect, useRef } from "react";
import { 
  Crosshair, Wrench, RefreshCw, Zap, 
  Target, Wind, Activity, Maximize, 
  Play, RotateCcw, ChevronRight, ChevronLeft,
  Cpu, ShieldCheck, Ruler, Scale, Eye, AlertTriangle,
  MousePointer2, ClipboardList, Trash2, CheckCircle2,
  Lock, Ban
} from "lucide-react";

// --- Configuration ---
const COLORS = {
  bg: 0x0b1121,
  grid: 0x1e293b,
  accent: 0x0ea5e9, 
  wood: 0x854d0e,
  metal: 0x64748b,
  danger: 0xef4444,
  success: 0x10b981,
  projectile: 0xfacc15
};

const loadThreeJS = () => new Promise((resolve, reject) => {
  if (window.THREE) return resolve(window.THREE);
  const script = document.createElement("script");
  script.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
  script.async = true;
  script.onload = () => resolve(window.THREE);
  script.onerror = (e) => reject(e);
  document.body.appendChild(script);
});

export default function CatapultCommanderV23() {
  const [activeTab, setActiveTab] = useState("MISSION"); 
  const [panelOpen, setPanelOpen] = useState(true);
  const [simState, setSimState] = useState("READY"); 
  const [cameraMode, setCameraMode] = useState("FREE");
  const [solverState, setSolverState] = useState("IDLE");
  const [bootStatus, setBootStatus] = useState("BOOTING");
  const [flightLogs, setFlightLogs] = useState([]); 
  const [autoCorrected, setAutoCorrected] = useState(false);
  
  const [specs, setSpecs] = useState({
    tension: 4000,      // N
    armLength: 6,       // m
    armMass: 25,        // kg
    projMass: 10,       // kg
    angle: 45,          // deg
    targetDist: 150,    // m
    wind: 0,            // m/s
    drag: 0.05          // Drag Coeff
  });

  const [telemetry, setTelemetry] = useState({ range: 0, velocity: 0, impactError: 0 });
  const containerRef = useRef(null);
  const engineRef = useRef(null);

  // --- CORE PHYSICS KERNEL (PURE FUNCTIONS) ---
  
  // 1. Analytic Launch Calculation (Energy Conservation)
  // This removes the "Time Step" error from the swing phase.
  // We calculate exactly what velocity the arm *should* have at release.
  const calculateLaunchVector = (p) => {
      const rad = p.angle * (Math.PI / 180);
      const releaseTheta = (p.angle - 90) * (Math.PI / 180);
      
      // Rotational Inertia (I)
      // I_arm (rod at end) = 1/3 ML^2
      // I_proj (point mass) = mL^2
      const I = (p.armMass * p.armLength**2)/3 + (p.projMass * p.armLength**2);
      
      // Energy stored in spring: PE = 0.5 * k * theta^2
      // Theta is the swing arc. Start: -135deg, End: Release Angle.
      // Approx Swing Arc ~ 2.3 radians (135 deg)
      const swingArc = 2.3; 
      const PE = 0.5 * p.tension * swingArc**2;
      
      // Efficiency loss (friction, air resistance on arm)
      const efficiency = 0.4; 
      const KE_usable = PE * efficiency;
      
      // KE = 0.5 * I * omega^2  => omega = sqrt(2*KE / I)
      const omega = Math.sqrt( (2 * KE_usable) / I );
      const vMag = omega * p.armLength;
      
      // Velocity Vector
      const vel = {
          x: Math.cos(rad) * vMag,
          y: Math.sin(rad) * vMag,
          z: 0
      };
      
      // Precise Release Position
      const pos = {
          x: 0 + Math.cos(releaseTheta) * p.armLength,
          y: 5.5 + Math.sin(releaseTheta) * p.armLength,
          z: 0
      };

      return { pos, vel };
  };

  // 2. Flight Integrator (Deterministic)
  const simulateFlightPath = (startPos, startVel, p) => {
      let pos = { ...startPos };
      let vel = { ...startVel };
      const dt = 0.016; // Fixed step
      
      for(let i=0; i<5000; i++) {
         const vSq = vel.x**2 + vel.y**2;
         const v = Math.sqrt(vSq);
         
         // Quadratic Drag
         const Fd = 0.5 * 1.225 * vSq * p.drag * 0.05; 
         
         // Acceleration
         const ax = -(Fd * (vel.x/v) + p.wind) / p.projMass;
         const ay = -(Fd * (vel.y/v)) / p.projMass - 9.81;
         
         vel.x += ax * dt;
         vel.y += ay * dt;
         pos.x += vel.x * dt;
         pos.y += vel.y * dt;
         
         if(pos.y <= 0) return pos.x; // Ground hit
      }
      return pos.x;
  };


  // --- THE OMNI-SOLVER (V23) ---
  const runOptimizer = () => {
    setSolverState("CALCULATING");
    setAutoCorrected(false);
    
    setTimeout(() => {
      
      // Strategy: Binary Search Tension for Optimal Angle
      // We know physics is monotonic for Tension (More Tension = More Distance)
      const solveTensionForAngle = (targetAngle) => {
         let min = 100, max = 150000; // Huge range
         let bestT = min;
         let bestErr = Infinity;
         
         for(let i=0; i<40; i++) {
            const mid = (min + max) / 2;
            
            // 1. Get Launch Vector using Analytic Math
            const launch = calculateLaunchVector({ ...specs, tension: mid, angle: targetAngle });
            
            // 2. Simulate Flight
            const dist = simulateFlightPath(launch.pos, launch.vel, specs);
            
            const err = dist - specs.targetDist;
            
            if (Math.abs(err) < bestErr) {
               bestErr = Math.abs(err);
               bestT = mid;
            }
            
            if (err > 0) max = mid; else min = mid;
         }
         return { t: bestT, err: bestErr };
      };

      // 1. Try Current Angle
      let solution = solveTensionForAngle(specs.angle);
      let finalAngle = specs.angle;

      // 2. If failed, Sweep ALL Angles to find physical possibility
      if (solution.err > 1.0) {
         let bestGlobal = solution;
         let bestGlobalAngle = specs.angle;
         
         // Sweep 10 to 80 degrees
         for (let a = 15; a <= 75; a += 5) {
             const attempt = solveTensionForAngle(a);
             if (attempt.err < bestGlobal.err) {
                 bestGlobal = attempt;
                 bestGlobalAngle = a;
             }
         }
         
         if (bestGlobal.err < 2.0) {
             solution = bestGlobal;
             finalAngle = bestGlobalAngle;
             setAutoCorrected(true);
         }
      }

      setSpecs(s => ({ ...s, tension: Math.round(solution.t), angle: Math.round(finalAngle) }));
      setSolverState("LOCKED");

    }, 500);
  };

  const generateTarget = () => {
    const dist = 50 + Math.random() * 400;
    const wind = (Math.random() * 40) - 20; 
    setSpecs(s => ({ ...s, targetDist: Math.floor(dist), wind: parseFloat(wind.toFixed(1)) }));
    setSolverState("IDLE");
    setSimState("READY");
    setAutoCorrected(false);
    engineRef.current?.reset();
  };

  // --- 3D Engine Initialization ---
  useEffect(() => {
    let frameId, isMounted = true, resizeObserver;
    const init = async () => {
      try {
        const THREE = await loadThreeJS();
        if (!isMounted || !containerRef.current) return;
        
        const width = containerRef.current.clientWidth;
        const height = containerRef.current.clientHeight;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(COLORS.bg);
        scene.fog = new THREE.FogExp2(COLORS.bg, 0.002);
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
        camera.position.set(-50, 40, 0); camera.lookAt(0, 10, 0);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        containerRef.current.innerHTML = "";
        containerRef.current.appendChild(renderer.domElement);
        
        const ambient = new THREE.AmbientLight(0xffffff, 0.6); scene.add(ambient);
        const sun = new THREE.DirectionalLight(0xffffff, 1.2);
        sun.position.set(-50, 100, 50); sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048); scene.add(sun);
        const grid = new THREE.GridHelper(5000, 250, COLORS.grid, 0x0f172a);
        grid.position.y = 0.1; scene.add(grid);
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(10000, 10000), new THREE.MeshStandardMaterial({ color: 0x050b14, roughness: 0.8 }));
        floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

        const catapultGroup = new THREE.Group();
        const woodMat = new THREE.MeshStandardMaterial({ color: COLORS.wood, roughness: 0.9 });
        const metalMat = new THREE.MeshStandardMaterial({ color: COLORS.metal, roughness: 0.4 });
        const base = new THREE.Group();
        const beamL = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 1), woodMat); beamL.position.set(0, 0.5, 2.5);
        const beamR = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 1), woodMat); beamR.position.set(0, 0.5, -2.5);
        const beamF = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 6), woodMat); beamF.position.set(5.5, 0.5, 0);
        const beamB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 6), woodMat); beamB.position.set(-5.5, 0.5, 0);
        const postL = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), woodMat); postL.position.set(0, 3, 2.5);
        const postR = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), woodMat); postR.position.set(0, 3, -2.5);
        const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 7, 16), metalMat);
        axle.rotation.x = Math.PI/2; axle.position.set(0, 5.5, 0);
        const stopBar = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 7, 16), metalMat);
        stopBar.rotation.x = Math.PI/2; stopBar.position.set(3, 7, 0); 
        const stopSupL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 0.5), woodMat); stopSupL.position.set(3, 5, 3);
        const stopSupR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 0.5), woodMat); stopSupR.position.set(3, 5, -3);
        base.add(beamL, beamR, beamF, beamB, postL, postR, axle, stopBar, stopSupL, stopSupR);
        catapultGroup.add(base);
        const armPivot = new THREE.Group(); armPivot.position.set(0, 5.5, 0);
        const armBeam = new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 0.8), woodMat);
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.0, 1.0, 16, 1, true), metalMat);
        armPivot.add(armBeam, cup); catapultGroup.add(armPivot); scene.add(catapultGroup);
        const projectile = new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 32), new THREE.MeshStandardMaterial({ color: COLORS.projectile, emissive: COLORS.projectile, emissiveIntensity: 0.5 }));
        projectile.castShadow = true; scene.add(projectile);
        const targetGroup = new THREE.Group();
        const tRing1 = new THREE.Mesh(new THREE.RingGeometry(5, 6, 32), new THREE.MeshBasicMaterial({ color: COLORS.danger, side: THREE.DoubleSide }));
        tRing1.rotation.x = -Math.PI/2; tRing1.position.y = 0.1;
        const tBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 100, 8), new THREE.MeshBasicMaterial({ color: COLORS.danger, transparent: true, opacity: 0.2 }));
        tBeam.position.y = 50; targetGroup.add(tRing1, tBeam); scene.add(targetGroup);
        const trailGeo = new THREE.BufferGeometry();
        const trailMat = new THREE.LineBasicMaterial({ color: COLORS.accent, linewidth: 2 });
        const trailLine = new THREE.Line(trailGeo, trailMat); scene.add(trailLine);
        setBootStatus("READY");

        const state = {
          phase: "READY", pos: new THREE.Vector3(0,0,0), vel: new THREE.Vector3(0,0,0),
          theta: -Math.PI / 4, trail: [], time: 0,
          camera: { radius: 80, theta: Math.PI/4, phi: Math.PI/3, center: new THREE.Vector3(0,10,0), dragging: false, lastMouse: {x:0, y:0} }
        };

        const handleMouse = (e) => {
          if(e.type==="mousedown") { state.camera.dragging=true; state.camera.lastMouse={x:e.clientX, y:e.clientY}; }
          if(e.type==="mouseup") state.camera.dragging=false;
          if(e.type==="mousemove" && state.camera.dragging) {
            const dx = e.clientX - state.camera.lastMouse.x;
            const dy = e.clientY - state.camera.lastMouse.y;
            state.camera.theta -= dx * 0.005;
            state.camera.phi = Math.max(0.1, Math.min(Math.PI/2 - 0.1, state.camera.phi - dy * 0.005));
            state.camera.lastMouse = {x:e.clientX, y:e.clientY};
          }
          if(e.type==="wheel") state.camera.radius = Math.max(20, Math.min(200, state.camera.radius + e.deltaY * 0.1));
        };
        renderer.domElement.addEventListener("mousedown", handleMouse);
        window.addEventListener("mousemove", handleMouse);
        window.addEventListener("mouseup", handleMouse);
        renderer.domElement.addEventListener("wheel", handleMouse);

        resizeObserver = new ResizeObserver(() => {
          if (!containerRef.current) return;
          const w = containerRef.current.clientWidth;
          const h = containerRef.current.clientHeight;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        });
        resizeObserver.observe(containerRef.current);

        engineRef.current = {
          specs: specs,
          fire: () => { state.phase = "FLIGHT_START"; state.trail = []; state.time = 0; setSimState("FIRED"); },
          reset: () => { state.phase = "READY"; state.theta = -Math.PI * 0.8; state.trail = []; trailLine.geometry.setFromPoints([new THREE.Vector3(0,0,0)]); setSimState("READY"); }
        };

        const animate = () => {
          if (!isMounted) return;
          frameId = requestAnimationFrame(animate);
          if (!engineRef.current) return;
          const p = engineRef.current.specs;
          const dt = 0.016; 
          
          // Visual Geometry Update
          const len = p.armLength;
          armBeam.scale.set(len, 1, 1); armBeam.position.set(-len/2, 0, 0); cup.position.set(-len, 0.8, 0);
          
          const getCupPos = (angle) => {
             const cupLocal = new THREE.Vector3(-len, 0.8, 0);
             cupLocal.applyAxisAngle(new THREE.Vector3(0,0,1), angle);
             cupLocal.add(new THREE.Vector3(0,5.5,0));
             return cupLocal;
          };

          if (state.phase === "READY") {
             state.theta = THREE.MathUtils.lerp(state.theta, -Math.PI*0.75, 0.1);
             armPivot.rotation.z = state.theta;
             projectile.visible = true;
             projectile.position.copy(getCupPos(state.theta));
          } 
          else if (state.phase === "FLIGHT_START") {
             // Skip Swing Phase visual (since we compute purely analytically now for precision)
             // We just snap to release
             const releaseTheta = (p.angle - 90) * (Math.PI / 180);
             state.theta = releaseTheta;
             armPivot.rotation.z = state.theta;
             
             // Use SHARED Analytic Launch Math
             const launch = calculateLaunchVector(p);
             state.pos = new THREE.Vector3(launch.pos.x, launch.pos.y, launch.pos.z);
             state.vel = new THREE.Vector3(launch.vel.x, launch.vel.y, launch.vel.z);
             
             state.phase = "FLIGHT";
          }
          else if (state.phase === "FLIGHT") {
             state.time += dt;
             // Arm Recoil Visual
             armPivot.rotation.z = state.theta + Math.sin(state.time * 20) * 0.2 * Math.exp(-state.time);

             // Flight Integration
             const vSq = state.vel.lengthSq();
             const v = Math.sqrt(vSq);
             
             const Fd = 0.5 * 1.225 * vSq * p.drag * 0.05; 
             const ax = -(Fd * (state.vel.x/v) + p.wind) / p.projMass;
             const ay = -(Fd * (state.vel.y/v)) / p.projMass - 9.81;
             
             state.vel.x += ax * dt;
             state.vel.y += ay * dt;
             state.pos.add(state.vel.clone().multiplyScalar(dt));
             
             if (state.pos.y <= 0) {
               state.pos.y = 0; state.phase = "IMPACT"; setSimState("IMPACT");
               const err = state.pos.x - p.targetDist;
               setTelemetry({ range: state.pos.x, velocity: 0, impactError: err });
               setFlightLogs(prev => [...prev, { id: Date.now(), range: state.pos.x.toFixed(1), error: err.toFixed(1), tension: p.tension, angle: p.angle }]);
             }
             projectile.position.copy(state.pos);
             if (state.trail.length < 500 && state.time % 0.05 < dt) {
                state.trail.push(state.pos.clone()); trailLine.geometry.setFromPoints(state.trail);
             }
          }

          // Camera
          const cx = state.camera.radius * Math.sin(state.camera.phi) * Math.sin(state.camera.theta);
          const cy = state.camera.radius * Math.cos(state.camera.phi);
          const cz = state.camera.radius * Math.sin(state.camera.phi) * Math.cos(state.camera.theta);
          let targetPos = new THREE.Vector3(0, 10, 0);
          if (cameraMode === "TRACKING" && (state.phase === "FLIGHT" || state.phase === "IMPACT")) targetPos.copy(state.pos);
          state.camera.center.lerp(targetPos, 0.1);
          camera.position.set(state.camera.center.x + cx, state.camera.center.y + cy, state.camera.center.z + cz);
          camera.lookAt(state.camera.center);
          targetGroup.position.set(p.targetDist, 0, 0);
          renderer.render(scene, camera);
        };
        animate();
      } catch (e) { console.error(e); setBootStatus("ERROR"); }
    };
    init();
    return () => { isMounted = false; if (frameId) cancelAnimationFrame(frameId); if (resizeObserver) resizeObserver.disconnect(); };
  }, [cameraMode]); 

  useEffect(() => { if (engineRef.current) engineRef.current.specs = specs; }, [specs]);

  const handleFire = () => engineRef.current?.fire();
  const handleReset = () => engineRef.current?.reset();

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 font-sans overflow-hidden select-none">
      <div className="absolute inset-0 z-0 bg-black cursor-crosshair">
        {bootStatus === "BOOTING" && <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 z-50 text-cyan-500 font-mono text-sm animate-pulse">INITIALIZING PHYSICS CORE...</div>}
        <div ref={containerRef} className="w-full h-full" />
      </div>
      <div className="absolute top-4 left-4 z-10 flex space-x-4 pointer-events-none">
        <div className="bg-slate-900/80 backdrop-blur border border-cyan-500/30 p-3 rounded-lg shadow-lg flex items-center space-x-6 text-xs font-mono">
           <div className="flex flex-col"><span className="text-slate-500">TENSION</span><span className="text-cyan-400 text-lg">{(specs.tension)} <span className="text-[10px]">N</span></span></div>
           <div className="h-6 w-px bg-slate-700"></div>
           <div className="flex flex-col"><span className="text-slate-500">RANGE</span><span className="text-white text-lg">{telemetry.range.toFixed(1)} <span className="text-[10px]">m</span></span></div>
           <div className="h-6 w-px bg-slate-700"></div>
           <div className="flex flex-col"><span className="text-slate-500">WIND</span><span className={`${specs.wind !== 0 ? "text-red-400" : "text-slate-400"} text-lg`}>{specs.wind} <span className="text-[10px]">m/s</span></span></div>
        </div>
      </div>
      <div className={`absolute top-4 bottom-4 right-4 z-20 w-[300px] bg-slate-900/90 backdrop-blur-md border border-slate-800 rounded-xl shadow-2xl flex flex-col transition-transform duration-300 ${panelOpen ? "translate-x-0" : "translate-x-[320px]"}`}>
         <div className="flex border-b border-slate-800">
            <button onClick={() => setActiveTab("MISSION")} className={`flex-1 py-4 text-[10px] font-bold flex items-center justify-center space-x-1 border-b-2 transition-colors ${activeTab === "MISSION" ? "border-cyan-500 text-cyan-400 bg-slate-800/50" : "border-transparent text-slate-500 hover:text-white"}`}><Crosshair className="w-3 h-3" /> <span>MISSION</span></button>
            <button onClick={() => setActiveTab("LAB")} className={`flex-1 py-4 text-[10px] font-bold flex items-center justify-center space-x-1 border-b-2 transition-colors ${activeTab === "LAB" ? "border-amber-500 text-amber-400 bg-slate-800/50" : "border-transparent text-slate-500 hover:text-white"}`}><Wrench className="w-3 h-3" /> <span>LAB</span></button>
            <button onClick={() => setActiveTab("LOGS")} className={`flex-1 py-4 text-[10px] font-bold flex items-center justify-center space-x-1 border-b-2 transition-colors ${activeTab === "LOGS" ? "border-emerald-500 text-emerald-400 bg-slate-800/50" : "border-transparent text-slate-500 hover:text-white"}`}><ClipboardList className="w-3 h-3" /> <span>LOGS</span></button>
         </div>
         <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {activeTab === "MISSION" && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-2">
                 <div className="p-3 bg-slate-950 rounded border border-slate-800 space-y-3">
                    <div className="flex justify-between items-center text-[10px] font-bold text-slate-500 uppercase"><span>Target Acquisition</span><Target className="w-3 h-3 text-red-500" /></div>
                    <div className="flex items-center space-x-2"><button onClick={generateTarget} className="bg-slate-800 hover:bg-slate-700 text-white p-2 rounded transition-colors"><RefreshCw className="w-3 h-3" /></button><div className="flex-1 bg-black/50 p-2 rounded text-right font-mono text-cyan-400 text-xs border border-cyan-900/30">{specs.targetDist}m</div></div>
                 </div>
                 <div className="p-3 bg-slate-950 rounded border border-slate-800 space-y-3 relative overflow-hidden">
                    {solverState === "CALCULATING" && <div className="absolute inset-0 bg-cyan-500/10 animate-pulse"></div>}
                    <div className="flex justify-between items-center text-[10px] font-bold text-slate-500 uppercase relative z-10"><span>Tactical Computer</span><Cpu className={`w-3 h-3 ${solverState === "LOCKED" ? "text-emerald-500" : "text-slate-600"}`} /></div>
                    
                    {autoCorrected && <div className="text-[9px] text-amber-400 flex items-center"><AlertTriangle className="w-3 h-3 mr-1" /> Angle auto-corrected for range.</div>}
                    
                    <button onClick={runOptimizer} disabled={solverState === "CALCULATING"} className={`w-full py-2 rounded text-[10px] font-bold flex items-center justify-center space-x-2 transition-all relative z-10 ${solverState === "LOCKED" ? "bg-emerald-900/30 text-emerald-400 border border-emerald-500/50" : "bg-cyan-600 hover:bg-cyan-500 text-white"}`}>{solverState === "CALCULATING" ? <RefreshCw className="w-3 h-3 animate-spin"/> : solverState === "LOCKED" ? <CheckCircle2 className="w-3 h-3"/> : <Activity className="w-3 h-3"/>}<span>{solverState === "LOCKED" ? "TARGET LOCKED" : "CALCULATE SOLUTION"}</span></button>
                 </div>
                 <div className="space-y-3 pt-2"><h3 className="text-[10px] font-bold text-slate-500 uppercase">Mission Variables</h3><InputSlider label="Angle" value={specs.angle} min={10} max={80} onChange={v => setSpecs({...specs, angle: v})} unit="°" /><InputSlider label="Wind" value={specs.wind} min={-20} max={20} onChange={v => setSpecs({...specs, wind: v})} unit="m/s" color="text-red-400" /></div>
              </div>
            )}
            {activeTab === "LAB" && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-2">
                 <div className="p-3 bg-amber-900/10 border border-amber-500/20 rounded text-[10px] text-amber-200/80 leading-relaxed">Engineering Deck: Modifying these values alters the catapult's physics model.</div>
                 <div className="space-y-3"><h3 className="text-[10px] font-bold text-slate-500 uppercase">Structural Specs</h3><InputSlider label="Arm Length" value={specs.armLength} min={3} max={10} step={0.5} onChange={v => setSpecs({...specs, armLength: v})} unit="m" color="text-amber-400" /><InputSlider label="Arm Mass" value={specs.armMass} min={10} max={100} onChange={v => setSpecs({...specs, armMass: v})} unit="kg" color="text-amber-400" /></div>
                 <div className="space-y-3 pt-4 border-t border-slate-800"><h3 className="text-[10px] font-bold text-slate-500 uppercase">Power Train</h3><InputSlider label="Tension" value={specs.tension} min={1000} max={80000} step={100} onChange={v => setSpecs({...specs, tension: v})} unit="N" color="text-emerald-400" /><InputSlider label="Payload Mass" value={specs.projMass} min={1} max={50} onChange={v => setSpecs({...specs, projMass: v})} unit="kg" /></div>
              </div>
            )}
            {activeTab === "LOGS" && (
              <div className="space-y-3 animate-in fade-in slide-in-from-right-2">
                 <div className="flex justify-between items-center"><h3 className="text-[10px] font-bold text-emerald-500 uppercase">Flight Data</h3><button onClick={() => setFlightLogs([])} className="text-slate-500 hover:text-red-400"><Trash2 className="w-3 h-3" /></button></div>
                 {flightLogs.length === 0 ? <div className="text-center text-slate-600 text-[10px] py-10 italic">No flight data recorded.</div> : <div className="space-y-2 max-h-[400px] overflow-y-auto">{flightLogs.map((log, i) => (<div key={log.id} className="bg-slate-950 border border-slate-800 rounded p-2 text-[10px] flex justify-between items-center"><span className="text-slate-500 font-mono w-4">#{i+1}</span><div><div className="text-white font-bold">{log.range}m</div><div className="text-slate-500">T:{log.tension} | A:{log.angle}°</div></div><div className={`font-mono font-bold ${Math.abs(log.error) < 5 ? "text-emerald-400" : "text-red-400"}`}>{log.error > 0 ? "+" : ""}{log.error}m</div></div>))}</div>}
              </div>
            )}
         </div>
         <div className="p-4 bg-slate-900 border-t border-slate-800 grid grid-cols-2 gap-3">
            <button onClick={() => engineRef.current?.reset()} className="py-2 rounded bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-bold flex items-center justify-center transition-colors"><RotateCcw className="w-3 h-3 mr-2" /> RESET</button>
            <button onClick={() => engineRef.current?.fire()} disabled={simState !== "READY"} className={`py-2 rounded text-white text-[10px] font-bold flex items-center justify-center transition-all ${simState === "READY" ? "bg-red-600 hover:bg-red-500 shadow-lg shadow-red-900/30" : "bg-slate-800 text-slate-500 cursor-not-allowed"}`}><Zap className="w-3 h-3 mr-2" /> FIRE</button>
         </div>
         <button onClick={() => setPanelOpen(!panelOpen)} className="absolute top-1/2 -left-3 transform -translate-y-1/2 bg-slate-800 border border-slate-700 rounded-full p-1 text-slate-400 hover:text-white">{panelOpen ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}</button>
      </div>
      <div className="absolute bottom-6 left-6 z-10 flex space-x-2"><button onClick={() => setCameraMode(cameraMode === "FREE" ? "TRACKING" : "FREE")} className="bg-black/60 backdrop-blur hover:bg-black/80 text-white px-3 py-2 rounded-full text-[10px] font-bold border border-white/10 flex items-center transition-all">{cameraMode === "FREE" ? <Eye className="w-3 h-3 mr-2 text-slate-400"/> : <EyeOff className="w-3 h-3 mr-2 text-cyan-400"/>}{cameraMode === "FREE" ? "FREE CAM" : "TRACKING"}</button><div className="bg-black/60 backdrop-blur px-4 py-2 rounded-full text-[10px] text-slate-400 border border-white/10 flex items-center"><MousePointer2 className="w-3 h-3 mr-2" /> DRAG TO ROTATE</div></div>
      {simState === "IMPACT" && (
         <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none z-0">
            <div className={`backdrop-blur border px-8 py-4 rounded-xl flex flex-col items-center animate-bounce shadow-2xl ${Math.abs(telemetry.impactError) < 5 ? "bg-emerald-500/20 border-emerald-500 text-emerald-100 shadow-emerald-500/20" : "bg-red-500/20 border-red-500 text-red-100 shadow-red-500/20"}`}>
               <div className="flex items-center font-bold tracking-widest text-lg mb-1">{Math.abs(telemetry.impactError) < 5 ? <CheckCircle2 className="w-6 h-6 mr-3"/> : <ShieldCheck className="w-6 h-6 mr-3" />} {Math.abs(telemetry.impactError) < 5 ? "TARGET DESTROYED" : "IMPACT CONFIRMED"}</div>
               <div className="text-xs font-mono opacity-80">ERROR: {Math.abs(telemetry.impactError).toFixed(1)}m</div>
            </div>
         </div>
      )}
    </div>
  );
}

const InputSlider = ({ label, value, min, max, step, onChange, unit, color="text-cyan-400" }) => (
  <div>
    <div className="flex justify-between text-[10px] mb-2 text-slate-400"><span>{label}</span><span className={`font-mono ${color}`}>{typeof value === "number" ? value.toFixed(1) : value}{unit}</span></div>
    <input type="range" min={min} max={max} step={step || 1} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-600"/>
  </div>
);
