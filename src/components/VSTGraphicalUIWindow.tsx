import React, { useState, useEffect, useRef } from 'react';
import {
  VSTPluginInstance,
  VSTPluginDefinition,
  VSTParameterDef
} from '../audio/vstTypes';
import { globalVSTHostEngine } from '../services/VSTHostEngine';
import {
  X,
  Power,
  Volume2,
  Sliders,
  Sparkles,
  Maximize2,
  Minimize2,
  RotateCcw,
  SlidersHorizontal,
  Activity,
  Layers,
  Radio,
  Eye,
  Disc,
  Zap,
  Check,
  ChevronDown
} from 'lucide-react';

interface VSTGraphicalUIWindowProps {
  instance: VSTPluginInstance;
  onClose: () => void;
  onUpdateParam: (instanceId: string, paramId: string, value: number) => void;
  onUpdateBypass: (instanceId: string, enabled: boolean) => void;
  onUpdateWetDry: (instanceId: string, wetDry: number) => void;
  onApplyPreset?: (instanceId: string, presetId: string) => void;
}

export const VSTGraphicalUIWindow: React.FC<VSTGraphicalUIWindowProps> = ({
  instance,
  onClose,
  onUpdateParam,
  onUpdateBypass,
  onUpdateWetDry,
  onApplyPreset
}) => {
  const [activeTab, setActiveTab] = useState<'gui' | 'parameters'>('gui');
  const [pluginState, setPluginState] = useState<VSTPluginInstance>(instance);
  const [selectedPresetId, setSelectedPresetId] = useState<string>(instance.activePresetId || '');
  const [vuNeedleAngle, setVuNeedleAngle] = useState<number>(-40); // -40deg to +40deg for VU meter
  const [isDraggingKnob, setIsDraggingKnob] = useState<string | null>(null);

  const def = globalVSTHostEngine.getPluginById(instance.pluginId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    setPluginState(instance);
  }, [instance]);

  // Simulate real-time VU meter needle animation and spectrum analyzer
  useEffect(() => {
    let animationFrameId: number;

    const animateMeters = () => {
      if (pluginState.enabled) {
        // Calculate artificial VU response based on parameters
        const isComp = pluginState.name.toLowerCase().includes('cla') || pluginState.name.toLowerCase().includes('comp') || pluginState.name.toLowerCase().includes('limit');
        if (isComp) {
          const thresh = pluginState.parameters['threshold'] ?? pluginState.parameters['input'] ?? -12;
          const targetAngle = -35 + Math.random() * 25 + (thresh < -10 ? 15 : 5);
          setVuNeedleAngle((prev) => prev + (targetAngle - prev) * 0.15);
        } else {
          const noise = -20 + Math.random() * 40;
          setVuNeedleAngle((prev) => prev + (noise - prev) * 0.1);
        }
      } else {
        setVuNeedleAngle(-45); // Resting position when bypassed
      }

      animationFrameId = requestAnimationFrame(animateMeters);
    };

    animationFrameId = requestAnimationFrame(animateMeters);
    return () => cancelAnimationFrame(animationFrameId);
  }, [pluginState.enabled, pluginState.parameters, pluginState.name]);

  // Draw real-time FFT / Curve Graph for FabFilter / iZotope / EQ plugins
  useEffect(() => {
    if (activeTab !== 'gui' || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let phase = 0;

    const renderGraph = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Grid Lines
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;

      // Frequency Grid (Logarithmic representation 20Hz - 20kHz)
      [0.1, 0.25, 0.5, 0.75, 0.9].forEach((xRatio) => {
        ctx.beginPath();
        ctx.moveTo(xRatio * w, 0);
        ctx.lineTo(xRatio * w, h);
        ctx.stroke();
      });

      // dB Grid Lines
      [0.2, 0.4, 0.6, 0.8].forEach((yRatio) => {
        ctx.beginPath();
        ctx.moveTo(0, yRatio * h);
        ctx.lineTo(w, yRatio * h);
        ctx.stroke();
      });

      // Draw Spectrum Analyzer Wave
      if (pluginState.enabled) {
        ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';
        ctx.beginPath();
        ctx.moveTo(0, h);

        phase += 0.05;
        for (let x = 0; x <= w; x += 4) {
          const normX = x / w;
          const noise = Math.sin(normX * 12 + phase) * 8 + Math.cos(normX * 25 - phase * 0.5) * 5;
          const lowCut = pluginState.parameters['lowcut'] ?? 20;
          const highCut = pluginState.parameters['highcut'] ?? 18000;

          let attenuation = 1;
          if (normX < lowCut / 200) attenuation *= normX / (lowCut / 200);
          if (normX > highCut / 20000) attenuation *= 1 - (normX - highCut / 20000);

          const y = h * 0.7 - Math.abs(noise) * attenuation - Math.sin(normX * Math.PI) * 20;
          ctx.lineTo(x, Math.max(10, Math.min(h - 5, y)));
        }

        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();

        // Active EQ / Filter Response Curve
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2.5;
        ctx.shadowColor = '#10b981';
        ctx.shadowBlur = 8;
        ctx.beginPath();

        for (let x = 0; x <= w; x += 4) {
          const normX = x / w;
          const lowGain = pluginState.parameters['low_gain'] ?? pluginState.parameters['lowGain'] ?? 0;
          const midGain = pluginState.parameters['mid_gain'] ?? pluginState.parameters['midGain'] ?? 0;
          const highGain = pluginState.parameters['high_gain'] ?? pluginState.parameters['highGain'] ?? 0;

          const eqOffset =
            Math.exp(-Math.pow(normX - 0.2, 2) * 25) * lowGain * 2 +
            Math.exp(-Math.pow(normX - 0.5, 2) * 20) * midGain * 2 +
            Math.exp(-Math.pow(normX - 0.8, 2) * 25) * highGain * 2;

          const y = h / 2 - eqOffset;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        // Flat Line when Bypassed
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
      }

      animId = requestAnimationFrame(renderGraph);
    };

    renderGraph();
    return () => cancelAnimationFrame(animId);
  }, [activeTab, pluginState.enabled, pluginState.parameters]);

  const handleParamChange = (paramId: string, val: number) => {
    onUpdateParam(instance.instanceId, paramId, val);
    setPluginState((prev) => ({
      ...prev,
      parameters: {
        ...prev.parameters,
        [paramId]: val
      }
    }));
  };

  const handlePresetSelect = (presetId: string) => {
    setSelectedPresetId(presetId);
    if (onApplyPreset) {
      onApplyPreset(instance.instanceId, presetId);
    } else {
      const preset = def?.presets.find((p) => p.id === presetId);
      if (preset) {
        Object.entries(preset.parameters).forEach(([k, v]) => {
          onUpdateParam(instance.instanceId, k, v);
        });
        setPluginState((prev) => ({
          ...prev,
          activePresetId: presetId,
          parameters: {
            ...prev.parameters,
            ...preset.parameters
          }
        }));
      }
    }
  };

  const isWaves = def?.vendor.toLowerCase().includes('waves') || instance.vendor.toLowerCase().includes('waves') || instance.name.toLowerCase().includes('waves') || instance.name.toLowerCase().includes('cla');
  const isIZotope = def?.vendor.toLowerCase().includes('izotope') || instance.vendor.toLowerCase().includes('izotope') || instance.name.toLowerCase().includes('ozone') || instance.name.toLowerCase().includes('rx');
  const isFabFilter = def?.vendor.toLowerCase().includes('fabfilter') || instance.name.toLowerCase().includes('pro-q') || instance.name.toLowerCase().includes('pro-c');
  const isValhalla = def?.vendor.toLowerCase().includes('valhalla') || instance.name.toLowerCase().includes('valhalla');

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-6 animate-fadeIn">
      <div className="bg-[#0b0f19] border border-slate-700/80 rounded-2xl max-w-3xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden text-slate-100 ring-1 ring-white/10">
        
        {/* ========================================================================= */}
        {/* HARDWARE VST WINDOW TITLE BAR */}
        {/* ========================================================================= */}
        <div className="bg-gradient-to-r from-slate-900 via-[#131929] to-slate-900 px-4 py-3 border-b border-slate-800 flex items-center justify-between shrink-0 shadow-md">
          <div className="flex items-center gap-3">
            {/* Plugin Status LED */}
            <div
              className={`w-3 h-3 rounded-full transition-all ${
                pluginState.enabled
                  ? 'bg-emerald-400 shadow-[0_0_10px_#10b981]'
                  : 'bg-rose-500/50 shadow-none'
              }`}
            />

            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold tracking-wide font-sans text-white">
                  {def?.name || instance.name}
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded font-mono font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                  {def?.format || instance.format || 'VST2/VST3 Shell'}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-slate-800 text-slate-300">
                  {def?.vendor || instance.vendor}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                {def?.description || 'Индустриальный VST2/VST3/Shell плагин графического интерфейса'}
              </p>
            </div>
          </div>

          {/* Top Window Actions */}
          <div className="flex items-center gap-2">
            {/* View Mode Switcher */}
            <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                type="button"
                onClick={() => setActiveTab('gui')}
                className={`px-3 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                  activeTab === 'gui'
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Sparkles size={12} />
                Интерфейс (GUI)
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('parameters')}
                className={`px-3 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                  activeTab === 'parameters'
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Sliders size={12} />
                Параметры DSP
              </button>
            </div>

            {/* Bypass Power Button */}
            <button
              type="button"
              onClick={() => {
                const nextState = !pluginState.enabled;
                onUpdateBypass(instance.instanceId, nextState);
                setPluginState((prev) => ({ ...prev, enabled: nextState }));
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                pluginState.enabled
                  ? 'bg-emerald-600 text-white shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                  : 'bg-slate-800 text-slate-400 border border-slate-700'
              }`}
            >
              <Power size={13} />
              {pluginState.enabled ? 'Включен' : 'Байпас'}
            </button>

            {/* Close Modal */}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-all cursor-pointer"
              title="Закрыть окно плагина"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* TOP UTILITY STRIP (PRESETS & WET/DRY BLEND) */}
        {/* ========================================================================= */}
        <div className="bg-[#0f1422] px-5 py-2.5 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3 shrink-0">
          {/* Preset Selector */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-slate-400 flex items-center gap-1">
              <Layers size={12} className="text-cyan-400" /> Пресет:
            </span>
            <select
              value={selectedPresetId}
              onChange={(e) => handlePresetSelect(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono cursor-pointer min-w-[180px]"
            >
              <option value="" disabled>-- Выберите пресет --</option>
              {def?.presets && def.presets.length > 0 ? (
                def.presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))
              ) : (
                <option value="default_preset">Default Factory Setting</option>
              )}
            </select>
          </div>

          {/* Wet/Dry Mix Dial */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Volume2 size={13} className="text-cyan-400" />
              <span className="text-[11px] text-slate-300 font-medium">Wet / Dry:</span>
              <span className="text-xs font-mono font-bold text-cyan-400">
                {Math.round((pluginState.wetDry ?? 1.0) * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={pluginState.wetDry ?? 1.0}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                onUpdateWetDry(instance.instanceId, val);
                setPluginState((prev) => ({ ...prev, wetDry: val }));
              }}
              className="w-24 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
            />
          </div>
        </div>

        {/* ========================================================================= */}
        {/* MAIN BODY: GRAPHICAL CUSTOM INTERFACE (GUI) */}
        {/* ========================================================================= */}
        <div className="p-4 sm:p-6 overflow-y-auto custom-scrollbar flex-1 flex flex-col justify-center">
          {activeTab === 'gui' ? (
            <div className="space-y-6">
              
              {/* --------------------------------------------------------------------- */}
              {/* 1. WAVES CLA-76 / VINTAGE COMPRESSOR GRAPHICAL CHASSIS */}
              {/* --------------------------------------------------------------------- */}
              {isWaves ? (
                <div className="bg-gradient-to-b from-[#181c26] to-[#0d1017] p-6 rounded-2xl border-2 border-slate-700/80 shadow-2xl relative overflow-hidden ring-1 ring-white/5">
                  <div className="absolute top-2 left-4 text-[10px] font-mono text-slate-500 tracking-widest uppercase font-bold">
                    WAVES AUDIO • STUDIO RACK SERIES • VST SHELL ENGINE
                  </div>

                  {/* Brushed Metal Chassis Header */}
                  <div className="flex justify-between items-center pb-4 mb-5 border-b border-slate-800">
                    <div>
                      <h2 className="text-lg font-black tracking-wider text-slate-100 font-sans uppercase">
                        {instance.name}
                      </h2>
                      <p className="text-[11px] text-emerald-400 font-mono">Analog Studio Hardware Emulation</p>
                    </div>

                    {/* Analog VU Meter Frame */}
                    <div className="w-44 h-24 bg-[#e8e4ce] border-4 border-[#2b2b2b] rounded-lg shadow-inner relative flex flex-col items-center justify-end overflow-hidden">
                      <div className="text-[9px] font-mono text-slate-800 font-bold uppercase tracking-wider mb-1 z-10">
                        VU GAIN REDUCTION
                      </div>
                      <div className="w-full text-center text-[10px] text-rose-900 font-mono font-bold z-10 flex justify-between px-3 mb-2">
                        <span>-20</span>
                        <span>-10</span>
                        <span>-7</span>
                        <span>-3</span>
                        <span>0</span>
                        <span>+3</span>
                      </div>

                      {/* Moving Needle */}
                      <div
                        className="absolute bottom-1 left-1/2 w-0.5 h-16 bg-rose-700 origin-bottom transition-transform duration-75 ease-out shadow-sm"
                        style={{
                          transform: `translateX(-50%) rotate(${vuNeedleAngle}deg)`
                        }}
                      />
                      <div className="w-4 h-4 rounded-full bg-slate-900 absolute -bottom-2 left-1/2 -translate-x-1/2 border border-slate-600" />
                    </div>
                  </div>

                  {/* Rotary Controls & Buttons Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 items-center">
                    {/* Input Knob */}
                    <div className="flex flex-col items-center space-y-2">
                      <span className="text-xs font-bold text-slate-300 font-mono uppercase">Input Gain</span>
                      <div className="relative w-20 h-20 bg-gradient-to-b from-slate-700 to-slate-900 rounded-full border-2 border-slate-500 shadow-xl flex items-center justify-center cursor-pointer hover:border-cyan-400 transition-all">
                        <div
                          className="w-1.5 h-8 bg-cyan-400 rounded-full origin-bottom absolute top-2 transition-transform"
                          style={{
                            transform: `rotate(${((pluginState.parameters['input'] ?? pluginState.parameters['threshold'] ?? 0) / 24) * 135}deg)`
                          }}
                        />
                        <div className="w-8 h-8 rounded-full bg-slate-900 border border-slate-600 shadow-inner flex items-center justify-center text-[10px] font-mono font-bold text-cyan-300">
                          {Math.round(pluginState.parameters['input'] ?? pluginState.parameters['threshold'] ?? 0)}
                        </div>
                      </div>
                      <input
                        type="range"
                        min="-24"
                        max="24"
                        step="0.5"
                        value={pluginState.parameters['input'] ?? pluginState.parameters['threshold'] ?? 0}
                        onChange={(e) => handleParamChange('input', parseFloat(e.target.value))}
                        className="w-24 h-1 bg-slate-800 rounded-lg cursor-pointer accent-cyan-500"
                      />
                    </div>

                    {/* Output Knob */}
                    <div className="flex flex-col items-center space-y-2">
                      <span className="text-xs font-bold text-slate-300 font-mono uppercase">Output Level</span>
                      <div className="relative w-20 h-20 bg-gradient-to-b from-slate-700 to-slate-900 rounded-full border-2 border-slate-500 shadow-xl flex items-center justify-center cursor-pointer hover:border-emerald-400 transition-all">
                        <div
                          className="w-1.5 h-8 bg-emerald-400 rounded-full origin-bottom absolute top-2 transition-transform"
                          style={{
                            transform: `rotate(${((pluginState.parameters['output'] ?? pluginState.parameters['gain'] ?? 0) / 24) * 135}deg)`
                          }}
                        />
                        <div className="w-8 h-8 rounded-full bg-slate-900 border border-slate-600 shadow-inner flex items-center justify-center text-[10px] font-mono font-bold text-emerald-300">
                          {Math.round(pluginState.parameters['output'] ?? pluginState.parameters['gain'] ?? 0)}
                        </div>
                      </div>
                      <input
                        type="range"
                        min="-24"
                        max="24"
                        step="0.5"
                        value={pluginState.parameters['output'] ?? pluginState.parameters['gain'] ?? 0}
                        onChange={(e) => handleParamChange('output', parseFloat(e.target.value))}
                        className="w-24 h-1 bg-slate-800 rounded-lg cursor-pointer accent-emerald-500"
                      />
                    </div>

                    {/* Attack / Release Dials */}
                    <div className="flex flex-col items-center space-y-2">
                      <span className="text-xs font-bold text-slate-300 font-mono uppercase">Attack & Release</span>
                      <div className="flex gap-3">
                        <div className="text-center">
                          <span className="text-[10px] text-slate-400 font-mono">ATTACK</span>
                          <input
                            type="range"
                            min="1"
                            max="7"
                            step="0.1"
                            value={pluginState.parameters['attack'] ?? 4}
                            onChange={(e) => handleParamChange('attack', parseFloat(e.target.value))}
                            className="w-16 h-1.5 bg-slate-800 rounded-lg cursor-pointer accent-cyan-400"
                          />
                        </div>
                        <div className="text-center">
                          <span className="text-[10px] text-slate-400 font-mono">RELEASE</span>
                          <input
                            type="range"
                            min="1"
                            max="7"
                            step="0.1"
                            value={pluginState.parameters['release'] ?? 5}
                            onChange={(e) => handleParamChange('release', parseFloat(e.target.value))}
                            className="w-16 h-1.5 bg-slate-800 rounded-lg cursor-pointer accent-cyan-400"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Push-Button Ratio Matrix */}
                    <div className="flex flex-col items-center space-y-2">
                      <span className="text-xs font-bold text-slate-300 font-mono uppercase">Ratio Mode</span>
                      <div className="grid grid-cols-2 gap-1.5">
                        {[4, 8, 12, 20].map((r) => {
                          const active = (pluginState.parameters['ratio'] ?? 4) === r;
                          return (
                            <button
                              key={r}
                              type="button"
                              onClick={() => handleParamChange('ratio', r)}
                              className={`px-3 py-1.5 rounded text-xs font-bold font-mono transition-all cursor-pointer ${
                                active
                                  ? 'bg-amber-500 text-black shadow-[0_0_8px_#f59e0b]'
                                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                              }`}
                            >
                              {r}:1
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* --------------------------------------------------------------------- */}
              {/* 2. IZOTOPE OZONE / RX FUTURISTIC NEON CANVAS */}
              {/* --------------------------------------------------------------------- */}
              {isIZotope || isFabFilter ? (
                <div className="bg-[#0a0e17] p-5 rounded-2xl border border-cyan-500/30 shadow-2xl space-y-4">
                  <div className="flex justify-between items-center pb-2 border-b border-slate-800">
                    <div className="flex items-center gap-2">
                      <Activity size={16} className="text-cyan-400" />
                      <h2 className="text-sm font-bold text-cyan-300 font-mono uppercase tracking-wider">
                        {instance.name} • Spectral Analyzer & Visualizer
                      </h2>
                    </div>
                    <span className="text-[11px] font-mono text-slate-400">20 Hz - 20,000 Hz Log Scale</span>
                  </div>

                  {/* Interactive FFT Canvas */}
                  <div className="w-full h-48 bg-slate-950 rounded-xl border border-slate-800 overflow-hidden relative shadow-inner">
                    <canvas ref={canvasRef} width={640} height={192} className="w-full h-full block" />
                  </div>

                  {/* Quick Parameters Sliders */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                    {def?.parameters.slice(0, 3).map((p) => (
                      <div key={p.id} className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-300 font-medium">{p.name}</span>
                          <span className="font-mono text-cyan-400 font-bold">
                            {(pluginState.parameters[p.id] ?? p.defaultValue).toFixed(1)} {p.unit}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={p.min}
                          max={p.max}
                          step={p.step || 0.1}
                          value={pluginState.parameters[p.id] ?? p.defaultValue}
                          onChange={(e) => handleParamChange(p.id, parseFloat(e.target.value))}
                          className="w-full h-1.5 bg-slate-800 rounded-lg cursor-pointer accent-cyan-500"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* --------------------------------------------------------------------- */}
              {/* 3. UNIVERSAL SKEUOMORPHIC STUDIO RACK PANEL FOR OTHER VSTs */}
              {/* --------------------------------------------------------------------- */}
              {!isWaves && !isIZotope && !isFabFilter ? (
                <div className="bg-gradient-to-b from-[#131926] to-[#0a0d14] p-6 rounded-2xl border border-slate-700/80 shadow-2xl space-y-6">
                  <div className="flex justify-between items-center pb-3 border-b border-slate-800">
                    <div className="flex items-center gap-2">
                      <Radio size={16} className="text-emerald-400" />
                      <h2 className="text-sm font-bold text-slate-100 font-mono tracking-wider">
                        {instance.name} Graphical Interface
                      </h2>
                    </div>
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                      <Check size={12} /> Live DSP Active
                    </div>
                  </div>

                  {/* Grid of Interactive Knobs */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {def?.parameters.map((p) => {
                      const val = pluginState.parameters[p.id] ?? p.defaultValue;
                      const norm = (val - p.min) / (p.max - p.min || 1);
                      const rotAngle = -135 + norm * 270;

                      return (
                        <div key={p.id} className="bg-slate-950 p-4 rounded-xl border border-slate-800/90 flex flex-col items-center space-y-2">
                          <span className="text-[11px] font-bold text-slate-300 font-mono truncate max-w-[120px]" title={p.name}>
                            {p.name}
                          </span>

                          {/* Interactive Dial */}
                          <div className="relative w-16 h-16 bg-gradient-to-b from-slate-700 to-slate-900 rounded-full border border-slate-500 shadow-md flex items-center justify-center">
                            <div
                              className="w-1 h-6 bg-emerald-400 rounded-full origin-bottom absolute top-2 transition-transform"
                              style={{ transform: `rotate(${rotAngle}deg)` }}
                            />
                            <div className="w-6 h-6 rounded-full bg-slate-950 text-[9px] font-mono font-bold text-emerald-300 flex items-center justify-center">
                              {Math.round(val)}
                            </div>
                          </div>

                          <input
                            type="range"
                            min={p.min}
                            max={p.max}
                            step={p.step || (p.max - p.min) / 100}
                            value={val}
                            onChange={(e) => handleParamChange(p.id, parseFloat(e.target.value))}
                            className="w-full h-1.5 bg-slate-800 rounded-lg cursor-pointer accent-emerald-500 mt-1"
                          />

                          <span className="text-[10px] font-mono text-slate-400">
                            {val.toFixed(1)} {p.unit}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

            </div>
          ) : (
            /* ========================================================================= */
            /* PARAMETERS SLIDERS TABLE VIEW */
            /* ========================================================================= */
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Sliders size={14} className="text-emerald-400" />
                Все параметры DSP ({def?.parameters.length || 0})
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {def?.parameters.map((param) => {
                  const currentVal = pluginState.parameters[param.id] ?? param.defaultValue;

                  return (
                    <div key={param.id} className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-200 font-medium truncate max-w-[160px]">{param.name}</span>
                        <span className="font-mono text-emerald-400 font-bold">
                          {currentVal.toFixed(1)} {param.unit}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={param.min}
                        max={param.max}
                        step={param.step || (param.max - param.min) / 100}
                        value={currentVal}
                        onChange={(e) => handleParamChange(param.id, parseFloat(e.target.value))}
                        className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ========================================================================= */}
        {/* WINDOW FOOTER */}
        {/* ========================================================================= */}
        <div className="p-3.5 px-5 border-t border-slate-800 bg-slate-900/80 flex items-center justify-between text-xs shrink-0">
          <div className="flex items-center gap-4 text-slate-400 font-mono text-[11px]">
            <span>Latency: <strong className="text-slate-200">{def?.latencySamples || 0}</strong> smp</span>
            <span>Architecture: <strong className="text-slate-200">{def?.is64Bit ? 'x64' : 'x86'}</strong></span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-xl transition-all cursor-pointer shadow-sm"
          >
            Готово
          </button>
        </div>

      </div>
    </div>
  );
};
