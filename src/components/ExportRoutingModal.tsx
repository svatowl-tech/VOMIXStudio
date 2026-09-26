import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Save,
  X,
  Plus,
  Trash2,
  ArrowRight,
  RotateCcw,
  Sliders,
  Play,
  CheckCircle2,
  AlertTriangle,
  Info,
  Film,
  Mic,
  Scissors,
  Clock,
  Gauge,
  Volume2,
  Layers,
  Activity,
  ShieldCheck,
  FileAudio,
  Download,
  FileText,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Move,
  CornerDownRight,
  GitFork,
  Check,
  Settings2,
  Zap,
  RefreshCw,
  Unlink,
  Link2,
  HardDrive,
  Terminal
} from 'lucide-react';
import {
  globalRenderPipelineGraphManager,
  RenderPipelineGraph,
  PipelineNode,
  PipelineNodeType,
  PipelineConnection,
  NODE_DEFINITIONS,
  NodeCategory,
  NodePort,
  VideoExportQualityPreset,
  VideoExportParameters,
  DEFAULT_VIDEO_EXPORT_PARAMS,
  getExportParamsForPreset
} from '../services/RenderPipelineGraphManager';
import { toSafeArray } from '../utils/safeIterables';
import { TrackState, VocalBusState, MasterState } from '../audio/dawEngine';

interface ExportRoutingModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeCategory: string;
  tracks: TrackState[];
  vocalBus: VocalBusState;
  master: MasterState;
  videoFile: File | null;
  onRunPipeline: () => void;
}

export const ExportRoutingModal: React.FC<ExportRoutingModalProps> = ({
  isOpen,
  onClose,
  activeCategory,
  tracks,
  vocalBus,
  master,
  videoFile,
  onRunPipeline
}) => {
  const [graph, setGraph] = useState<RenderPipelineGraph>(() =>
    globalRenderPipelineGraphManager.getSerializableGraph()
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'canvas' | 'list'>('canvas');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('all');
  const [notification, setNotification] = useState<string | null>(null);
  
  // Dragging Node state
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Interactive Cable Wiring state
  const [connectingStart, setConnectingStart] = useState<{
    nodeId: string;
    portId: string;
    isOutput: boolean;
    x: number;
    y: number;
    color: string;
  } | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = globalRenderPipelineGraphManager.subscribe(() => {
      setGraph(globalRenderPipelineGraphManager.getSerializableGraph());
    });
    return unsub;
  }, []);

  if (!isOpen) return null;

  const safeNodes = toSafeArray<PipelineNode>(graph.nodes);
  const safeConnections = toSafeArray<PipelineConnection>(graph.connections);
  const selectedNode = safeNodes.find((n) => n.id === selectedNodeId) || safeNodes[0];
  const selectedConnection = safeConnections.find((c) => c.id === selectedConnId);

  const showToast = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  const handleToggleNode = (nodeId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    globalRenderPipelineGraphManager.toggleNodeEnabled(nodeId);
    showToast('Состояние ноды обновлено');
  };

  const handleDeleteNode = (nodeId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (safeNodes.length <= 2) {
      alert('В графе должно оставаться хотя бы две базовых ноды.');
      return;
    }
    if (window.confirm('Удалить эту ноду из роутинга рендера?')) {
      globalRenderPipelineGraphManager.deleteNode(nodeId);
      if (selectedNodeId === nodeId) {
        setSelectedNodeId(null);
      }
      showToast('Нода удалена из графа');
    }
  };

  const handleAddNode = (type: PipelineNodeType) => {
    const lastNode = safeNodes[safeNodes.length - 1];
    const newX = lastNode ? lastNode.x + 240 : 300;
    const newY = lastNode ? Math.max(60, lastNode.y + (Math.random() * 80 - 40)) : 150;
    const added = globalRenderPipelineGraphManager.addNode(type, newX, newY);
    setShowAddMenu(false);
    setSelectedNodeId(added.id);
    showToast(`Нода "${added.title}" добавлена в граф`);
  };

  const handleResetToDefault = () => {
    if (window.confirm(`Сбросить нодовый граф роутинга к стандарту режима [${activeCategory}]?`)) {
      const resetGraph = globalRenderPipelineGraphManager.loadDefaultGraphForCategory(activeCategory);
      setGraph(resetGraph);
      setSelectedNodeId(null);
      setSelectedConnId(null);
      showToast(`Роутинг сброшен к стандарту [${activeCategory}]`);
    }
  };

  const handleUpdateParam = (nodeId: string, key: string, value: any) => {
    const targetNode = safeNodes.find((n) => n.id === nodeId);
    if (!targetNode) return;
    const updatedParams = { ...targetNode.parameters, [key]: value };
    globalRenderPipelineGraphManager.updateNode(nodeId, { parameters: updatedParams });
  };

  const handleUpdateMultipleParams = (nodeId: string, newParams: Record<string, any>) => {
    const targetNode = safeNodes.find((n) => n.id === nodeId);
    if (!targetNode) return;
    const updatedParams = { ...targetNode.parameters, ...newParams };
    globalRenderPipelineGraphManager.updateNode(nodeId, { parameters: updatedParams });
  };

  const handleMoveNodeOrder = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= safeNodes.length) return;
    globalRenderPipelineGraphManager.reorderNodes(index, targetIndex);
  };

  // Node Dragging Handlers
  const handleMouseDownNodeHeader = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    const node = safeNodes.find((n) => n.id === nodeId);
    if (!node) return;
    setSelectedNodeId(nodeId);
    setSelectedConnId(null);
    setDraggingNodeId(nodeId);
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (canvasRect) {
      setDragOffset({
        x: e.clientX - canvasRect.left + (canvasRef.current?.scrollLeft || 0) - node.x,
        y: e.clientY - canvasRect.top + (canvasRef.current?.scrollTop || 0) - node.y
      });
    }
  };

  // Canvas Mouse Move
  const handleMouseMoveCanvas = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const curX = e.clientX - canvasRect.left + canvasRef.current.scrollLeft;
    const curY = e.clientY - canvasRect.top + canvasRef.current.scrollTop;
    setMousePos({ x: curX, y: curY });

    if (draggingNodeId) {
      const newX = Math.max(20, Math.min(3200, curX - dragOffset.x));
      const newY = Math.max(20, Math.min(900, curY - dragOffset.y));
      globalRenderPipelineGraphManager.updateNode(draggingNodeId, { x: newX, y: newY });
    }
  };

  const handleMouseUpCanvas = () => {
    setDraggingNodeId(null);
    if (connectingStart) {
      setConnectingStart(null);
    }
  };

  // Interactive Port Cable Connection Handlers
  const handleStartCableFromPort = (
    e: React.MouseEvent,
    node: PipelineNode,
    port: NodePort,
    isOutput: boolean,
    portIndex: number
  ) => {
    e.stopPropagation();
    const portY = node.y + 40 + portIndex * 24 + 12;
    const portX = isOutput ? node.x + 220 : node.x;

    setConnectingStart({
      nodeId: node.id,
      portId: port.id,
      isOutput,
      x: portX,
      y: portY,
      color: port.color || '#10b981'
    });
  };

  const handleCompleteCableAtPort = (
    e: React.MouseEvent,
    targetNode: PipelineNode,
    targetPort: NodePort,
    isTargetOutput: boolean
  ) => {
    e.stopPropagation();
    if (!connectingStart) return;

    if (connectingStart.nodeId === targetNode.id) {
      showToast('Нельзя соединять порт ноды с самой собой');
      setConnectingStart(null);
      return;
    }

    if (connectingStart.isOutput === isTargetOutput) {
      showToast('Нужно соединять Выход (Output) с Входом (Input)');
      setConnectingStart(null);
      return;
    }

    const fromNodeId = connectingStart.isOutput ? connectingStart.nodeId : targetNode.id;
    const fromPortId = connectingStart.isOutput ? connectingStart.portId : targetPort.id;
    const toNodeId = connectingStart.isOutput ? targetNode.id : connectingStart.nodeId;
    const toPortId = connectingStart.isOutput ? targetPort.id : connectingStart.portId;

    const fromNode = safeNodes.find((n) => n.id === fromNodeId);
    const toNode = safeNodes.find((n) => n.id === toNodeId);
    const isLoop = fromNode?.type === 'feedback_loop' || toNode?.type === 'feedback_loop' || fromPortId.includes('loop');

    globalRenderPipelineGraphManager.addPortConnection(fromNodeId, fromPortId, toNodeId, toPortId, isLoop);
    setConnectingStart(null);
    showToast(`Маршрут соединен: [${fromNode?.title}] -> [${toNode?.title}]`);
  };

  const handleDeleteConnection = (connId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    globalRenderPipelineGraphManager.deleteConnection(connId);
    if (selectedConnId === connId) {
      setSelectedConnId(null);
    }
    showToast('Маршрут удален');
  };

  const getNodeIcon = (iconName: string, size = 16) => {
    switch (iconName) {
      case 'Film':
        return <Film size={size} />;
      case 'Mic':
        return <Mic size={size} />;
      case 'FileText':
        return <FileText size={size} />;
      case 'Scissors':
        return <Scissors size={size} />;
      case 'Clock':
        return <Clock size={size} />;
      case 'Gauge':
        return <Gauge size={size} />;
      case 'Sparkles':
        return <Sparkles size={size} />;
      case 'Sliders':
        return <Sliders size={size} />;
      case 'Volume2':
        return <Volume2 size={size} />;
      case 'Layers':
        return <Layers size={size} />;
      case 'Activity':
        return <Activity size={size} />;
      case 'RotateCcw':
        return <RotateCcw size={size} />;
      case 'Save':
        return <Save size={size} />;
      case 'HardDrive':
        return <HardDrive size={size} />;
      case 'ShieldCheck':
        return <ShieldCheck size={size} />;
      case 'FileAudio':
        return <FileAudio size={size} />;
      case 'GitFork':
        return <GitFork size={size} />;
      default:
        return <Sparkles size={size} />;
    }
  };

  const activeNodesCount = safeNodes.filter((n) => n.enabled).length;
  const loopNodesCount = safeNodes.filter((n) => (n.type === 'feedback_loop' || n.type === 'lufs_target_gate') && n.enabled).length;

  const CATEGORY_NAMES: Record<string, string> = {
    all: 'Все категории',
    input: '📁 Входы',
    prep: '✂️ Подготовка & Тайминг',
    ai: '🧠 Нейросети (AI)',
    dsp: '🎛️ DSP & Эффекты',
    routing: '🔀 Маршрутизация & Отшивание',
    loop: '🔄 Петли & Кэш',
    disk: '💾 Сохранение на диск',
    output: '🎬 Экспорт & Муксинг'
  };

  const filteredNodeDefinitions = Object.entries(NODE_DEFINITIONS).filter(([_, def]) => {
    if (selectedCategoryFilter === 'all') return true;
    return def.category === selectedCategoryFilter;
  });

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-2 sm:p-4 animate-fadeIn select-none">
      <div className="bg-[#0b0f19] border border-cyan-500/40 rounded-3xl w-full max-w-[96vw] h-[94vh] flex flex-col shadow-2xl overflow-hidden">
        {/* 1. ВЕРХНИЙ ХЕДЕР МОДАЛЬНОГО ОКНА */}
        <div className="px-5 py-3.5 bg-[#0f1422] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 border border-cyan-500/40 rounded-2xl text-cyan-300 shadow-md shadow-cyan-950/50">
              <Settings2 size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100">
                  Нодовая структура роутинга сведения и экспорта
                </h2>
                <span className="px-2.5 py-0.5 bg-cyan-950/80 border border-cyan-700/60 text-cyan-300 rounded-lg text-xs font-mono font-bold">
                  [{activeCategory}]
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Управление портами входов/выходов, ветвление сигнала, сброс стемов на диск, отшивание дорожек и нодовые петли
              </p>
            </div>
          </div>

          {/* Правые контролы */}
          <div className="flex items-center gap-2">
            {/* Переключатель режима отображения: Холст / Список */}
            <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-0.5 text-xs font-semibold">
              <button
                onClick={() => setViewMode('canvas')}
                className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                  viewMode === 'canvas'
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Нодовый холст
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                  viewMode === 'list'
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Список этапов ({safeNodes.length})
              </button>
            </div>

            <button
              onClick={handleResetToDefault}
              className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 rounded-xl text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all"
              title="Сбросить нодовый роутинг к дефолту режима"
            >
              <RotateCcw size={13} />
              <span>Сбросить</span>
            </button>

            <button
              onClick={() => {
                onClose();
                onRunPipeline();
              }}
              className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-emerald-950/60 transition-all"
              title="Запустить выполнение конвейера сведения по текущему настроенному нодовому графу"
            >
              <Play size={14} className="fill-white" />
              <span>Запустить сведение</span>
            </button>

            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all cursor-pointer"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* 2. ПАНЕЛЬ БЫСТРЫХ ДЕЙСТВИЙ И СТАТИСТИКИ */}
        <div className="px-5 py-2.5 bg-slate-950/70 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <button
                onClick={() => setShowAddMenu(!showAddMenu)}
                className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-xl flex items-center gap-1.5 cursor-pointer transition-all shadow-md shadow-cyan-950/40"
              >
                <Plus size={14} />
                <span>+ Добавить ноду в роутинг</span>
                <ChevronDown size={13} />
              </button>

              {/* Меню добавления нод по категориям */}
              {showAddMenu && (
                <div className="absolute left-0 top-full mt-2 w-80 sm:w-96 bg-[#0f1422] border border-cyan-500/40 rounded-2xl shadow-2xl p-3 z-50 space-y-2 animate-fadeIn max-h-[70vh] overflow-y-auto">
                  <div className="flex items-center justify-between pb-1.5 border-b border-slate-800">
                    <span className="text-xs font-bold text-slate-200">Библиотека нод конвейера</span>
                    <button onClick={() => setShowAddMenu(false)} className="text-slate-400 hover:text-white">
                      <X size={14} />
                    </button>
                  </div>

                  {/* Фильтр по категориям */}
                  <div className="flex flex-wrap gap-1 pb-1">
                    {Object.entries(CATEGORY_NAMES).map(([catKey, catLabel]) => (
                      <button
                        key={catKey}
                        onClick={() => setSelectedCategoryFilter(catKey)}
                        className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold cursor-pointer transition-all ${
                          selectedCategoryFilter === catKey
                            ? 'bg-cyan-600 text-white'
                            : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        {catLabel}
                      </button>
                    ))}
                  </div>

                  <div className="space-y-1 pr-1 max-h-80 overflow-y-auto scrollbar-thin">
                    {filteredNodeDefinitions.map(([typeKey, def]) => (
                      <button
                        key={typeKey}
                        onClick={() => handleAddNode(typeKey as PipelineNodeType)}
                        className="w-full p-2 hover:bg-slate-900 rounded-xl text-left flex items-start gap-2.5 transition-all text-xs text-slate-200 hover:text-white cursor-pointer group border border-transparent hover:border-slate-800"
                      >
                        <span
                          className="p-1.5 rounded-lg shrink-0 group-hover:scale-110 transition-transform"
                          style={{ color: def.color, backgroundColor: `${def.color}20` }}
                        >
                          {getNodeIcon(def.iconName, 15)}
                        </span>
                        <div className="min-w-0">
                          <div className="font-bold flex items-center gap-1.5">
                            <span className="truncate">{def.title}</span>
                            <span className="text-[9px] px-1 bg-slate-800 text-slate-400 rounded">
                              {def.category}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-400 line-clamp-1">{def.description}</div>
                          <div className="text-[9px] text-cyan-400 font-mono flex items-center gap-2 mt-0.5">
                            <span>Входов: {def.defaultInputs.length}</span>
                            <span>•</span>
                            <span>Выходов: {def.defaultOutputs.length}</span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 text-slate-400 font-mono text-[11px]">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                Нод: <strong className="text-emerald-300">{activeNodesCount}</strong> / {safeNodes.length}
              </span>
              <span>•</span>
              <span className="flex items-center gap-1 text-cyan-300">
                <Link2 size={12} className="text-cyan-400" />
                Маршрутов: <strong>{safeConnections.length}</strong>
              </span>
              <span>•</span>
              <span className="flex items-center gap-1 text-purple-300">
                <RotateCcw size={12} className="text-purple-400" />
                Петель: <strong>{loopNodesCount}</strong>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
            <span className="hidden sm:inline">
              Подсказка: <strong>Тяните провод от любого Выхода (Output) ко Входу (Input)</strong>
            </span>
          </div>
        </div>

        {/* 3. ОСНОВНАЯ ОБЛАСТЬ: НОДОВЫЙ ХОЛСТ С ПОРТАМИ + ИНСПЕКТОР РОУТИНГА СПРАВА */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Левая интерактивная часть: Холст с портами */}
          <div className="flex-1 flex flex-col bg-[#070a13] relative overflow-hidden">
            {viewMode === 'canvas' ? (
              <div
                ref={canvasRef}
                onMouseMove={handleMouseMoveCanvas}
                onMouseUp={handleMouseUpCanvas}
                className="w-full h-full overflow-auto relative p-8 cursor-crosshair bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:24px_24px]"
              >
                {/* SVG Линии связей между портами */}
                <svg className="absolute inset-0 w-[3400px] h-[1000px] pointer-events-none z-0">
                  <defs>
                    <linearGradient id="wireGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.85" />
                      <stop offset="100%" stopColor="#10b981" stopOpacity="0.85" />
                    </linearGradient>
                    <linearGradient id="loopGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#ef4444" stopOpacity="0.9" />
                      <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.9" />
                    </linearGradient>
                    <linearGradient id="activeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity="1.0" />
                      <stop offset="100%" stopColor="#ec4899" stopOpacity="1.0" />
                    </linearGradient>
                  </defs>

                  {/* Рендеринг всех сохраненных связей портов */}
                  {safeConnections.map((conn) => {
                    const fromNode = safeNodes.find((n) => n.id === conn.fromNodeId);
                    const toNode = safeNodes.find((n) => n.id === conn.toNodeId);
                    if (!fromNode || !toNode) return null;

                    const fromOutputs = toSafeArray<NodePort>(fromNode.outputs);
                    const toInputs = toSafeArray<NodePort>(toNode.inputs);

                    const outIndex = fromOutputs.findIndex((p) => p.id === conn.fromPortId);
                    const inIndex = toInputs.findIndex((p) => p.id === conn.toPortId);

                    const startX = fromNode.x + 220;
                    const startY = fromNode.y + 40 + (outIndex >= 0 ? outIndex : 0) * 24 + 12;

                    const endX = toNode.x;
                    const endY = toNode.y + 40 + (inIndex >= 0 ? inIndex : 0) * 24 + 12;

                    const isSelected = selectedConnId === conn.id;
                    const dx = Math.max(50, Math.abs(endX - startX) / 2);

                    const pathData = conn.isLoop
                      ? `M ${startX} ${startY} C ${startX + 100} ${startY + 110}, ${endX - 100} ${endY + 110}, ${endX} ${endY}`
                      : `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;

                    return (
                      <g
                        key={conn.id}
                        className="cursor-pointer pointer-events-auto"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedConnId(conn.id);
                          setSelectedNodeId(null);
                        }}
                      >
                        {/* Невидимая широкая зона клика */}
                        <path d={pathData} fill="none" stroke="transparent" strokeWidth={16} />
                        {/* Видимый провод */}
                        <path
                          d={pathData}
                          fill="none"
                          stroke={
                            isSelected
                              ? 'url(#activeGrad)'
                              : conn.isLoop
                              ? 'url(#loopGrad)'
                              : 'url(#wireGrad)'
                          }
                          strokeWidth={isSelected ? 4.5 : conn.isLoop ? 3.5 : 2.5}
                          strokeDasharray={conn.isLoop ? '6,4' : undefined}
                          className={conn.isLoop || isSelected ? 'animate-pulse' : ''}
                        />
                        {/* Маркер направления */}
                        <circle
                          cx={(startX + endX) / 2}
                          cy={conn.isLoop ? (startY + endY) / 2 + 55 : (startY + endY) / 2}
                          r={isSelected ? 6 : 4}
                          fill={isSelected ? '#f59e0b' : conn.isLoop ? '#ef4444' : '#10b981'}
                        />
                      </g>
                    );
                  })}

                  {/* Живой провод при перетягивании кабеля */}
                  {connectingStart && (
                    <path
                      d={`M ${connectingStart.x} ${connectingStart.y} C ${
                        connectingStart.x + (mousePos.x - connectingStart.x) / 2
                      } ${connectingStart.y}, ${
                        mousePos.x - (mousePos.x - connectingStart.x) / 2
                      } ${mousePos.y}, ${mousePos.x} ${mousePos.y}`}
                      fill="none"
                      stroke={connectingStart.color || '#f59e0b'}
                      strokeWidth={3.5}
                      strokeDasharray="4,4"
                      className="animate-pulse"
                    />
                  )}
                </svg>

                {/* Рендеринг визуальных нод со списком портов */}
                {safeNodes.map((node, index) => {
                  const isSelected = selectedNode?.id === node.id;
                  const isLoop = node.type === 'feedback_loop';
                  const inputs = toSafeArray<NodePort>(node.inputs);
                  const outputs = toSafeArray<NodePort>(node.outputs);

                  return (
                    <div
                      key={node.id}
                      style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedNodeId(node.id);
                        setSelectedConnId(null);
                      }}
                      className={`absolute w-56 rounded-2xl border transition-shadow select-none z-10 ${
                        isSelected
                          ? 'border-cyan-400 bg-[#0f172a] shadow-2xl shadow-cyan-950/90 ring-2 ring-cyan-500/50'
                          : node.enabled
                          ? 'border-slate-800 bg-[#0b1120]/95 hover:border-slate-700 shadow-lg'
                          : 'border-slate-900 bg-slate-950/60 opacity-50'
                      }`}
                    >
                      {/* Хедер ноды (перетаскивание за хедер) */}
                      <div
                        onMouseDown={(e) => handleMouseDownNodeHeader(e, node.id)}
                        className="p-2.5 border-b border-slate-800/80 flex items-center justify-between gap-2 rounded-t-2xl cursor-grab active:cursor-grabbing"
                        style={{
                          backgroundColor: node.enabled ? `${node.color || '#06b6d4'}18` : 'transparent'
                        }}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="p-1 rounded-lg shrink-0"
                            style={{ color: node.color || '#06b6d4' }}
                          >
                            {getNodeIcon(node.iconName || 'Sparkles', 15)}
                          </span>
                          <span className="text-xs font-bold text-slate-100 truncate">{node.title}</span>
                        </div>

                        {/* Кнопка Вкл/Выкл */}
                        <button
                          onClick={(e) => handleToggleNode(node.id, e)}
                          className={`w-4 h-4 rounded flex items-center justify-center text-[10px] cursor-pointer transition-all ${
                            node.enabled
                              ? 'bg-emerald-500 text-slate-950 font-bold'
                              : 'bg-slate-800 text-slate-500 hover:bg-slate-700'
                          }`}
                          title={node.enabled ? 'Байпас / Отключить ноду' : 'Включить ноду'}
                        >
                          {node.enabled ? <Check size={11} /> : <X size={11} />}
                        </button>
                      </div>

                      {/* СЕКЦИЯ ПОРТОВ: Входы слева, Выходы справа */}
                      <div className="p-2.5 space-y-2 text-xs">
                        <div className="grid grid-cols-2 gap-2">
                          {/* Колонка Входов (Inputs) */}
                          <div className="space-y-1.5">
                            <div className="text-[9px] font-mono uppercase text-slate-400 font-bold">
                              Входы ({inputs.length})
                            </div>
                            {inputs.length === 0 ? (
                              <div className="text-[9px] text-slate-400 italic">Источник</div>
                            ) : (
                              inputs.map((port, pIdx) => {
                                const isPortConnected = safeConnections.some(
                                  (c) => c.toNodeId === node.id && c.toPortId === port.id
                                );
                                return (
                                  <div
                                    key={port.id}
                                    className="flex items-center gap-1.5 group/port cursor-pointer"
                                    onClick={(e) => handleCompleteCableAtPort(e, node, port, false)}
                                    title={`Вход: ${port.label} (${port.type}). Кликните, чтобы завершить провод.`}
                                  >
                                    {/* Точка сокета */}
                                    <div
                                      className={`w-3 h-3 rounded-full border-2 transition-all flex items-center justify-center ${
                                        isPortConnected
                                          ? 'bg-emerald-400 border-white ring-2 ring-emerald-500/40'
                                          : 'bg-slate-900 border-slate-600 hover:border-cyan-400 hover:scale-125'
                                      }`}
                                      style={{ borderColor: port.color || '#10b981' }}
                                    >
                                      {isPortConnected && <div className="w-1 h-1 rounded-full bg-slate-950"></div>}
                                    </div>
                                    <span className="text-[10px] text-slate-300 truncate max-w-[70px] group-hover/port:text-cyan-300">
                                      {port.label}
                                    </span>
                                  </div>
                                );
                              })
                            )}
                          </div>

                          {/* Колонка Выходов (Outputs) */}
                          <div className="space-y-1.5 text-right">
                            <div className="text-[9px] font-mono uppercase text-slate-400 font-bold">
                              Выходы ({outputs.length})
                            </div>
                            {outputs.length === 0 ? (
                              <div className="text-[9px] text-slate-400 italic">Сток / Конец</div>
                            ) : (
                              outputs.map((port, pIdx) => {
                                const isPortConnected = safeConnections.some(
                                  (c) => c.fromNodeId === node.id && c.fromPortId === port.id
                                );
                                return (
                                  <div
                                    key={port.id}
                                    className="flex items-center justify-end gap-1.5 group/port cursor-pointer"
                                    onMouseDown={(e) => handleStartCableFromPort(e, node, port, true, pIdx)}
                                    title={`Выход: ${port.label} (${port.type}). Потяните отсюда провод.`}
                                  >
                                    <span className="text-[10px] text-slate-300 truncate max-w-[70px] group-hover/port:text-cyan-300">
                                      {port.label}
                                    </span>
                                    {/* Точка сокета */}
                                    <div
                                      className={`w-3 h-3 rounded-full border-2 transition-all flex items-center justify-center ${
                                        isPortConnected
                                          ? 'bg-cyan-400 border-white ring-2 ring-cyan-500/40'
                                          : 'bg-slate-900 border-slate-600 hover:border-cyan-400 hover:scale-125'
                                      }`}
                                      style={{ borderColor: port.color || '#06b6d4' }}
                                    >
                                      {isPortConnected && <div className="w-1 h-1 rounded-full bg-slate-950"></div>}
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>

                        {/* Индикатор петли */}
                        {isLoop && (
                          <div className="px-2 py-0.5 bg-rose-950/60 border border-rose-800/60 text-rose-300 rounded text-[9px] font-mono flex items-center justify-between font-bold">
                            <span>Петля: {node.parameters.iterations || 2}x</span>
                            <RotateCcw size={10} />
                          </div>
                        )}

                        <div className="flex items-center justify-between text-[9px] font-mono text-slate-400 pt-1 border-t border-slate-800/60">
                          <span>#{index + 1}</span>
                          <span className="text-cyan-400 truncate max-w-[80px]">{node.category}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* СПИСОЧНЫЙ РЕЖИМ КОНВЕЙЕРА (Sequential Step List) */
              <div className="w-full h-full overflow-y-auto p-6 space-y-3">
                <div className="text-xs text-slate-400 flex items-center justify-between mb-2">
                  <span>Последовательность выполнения этапов сведения (пост-обработка):</span>
                  <span className="text-cyan-400 font-mono">Всего этапов: {safeNodes.length}</span>
                </div>

                {safeNodes.map((node, idx) => {
                  const isSelected = selectedNode?.id === node.id;
                  const inputs = toSafeArray<NodePort>(node.inputs);
                  const outputs = toSafeArray<NodePort>(node.outputs);

                  return (
                    <div
                      key={node.id}
                      onClick={() => {
                        setSelectedNodeId(node.id);
                        setSelectedConnId(null);
                      }}
                      className={`p-4 rounded-2xl border transition-all flex items-center justify-between gap-4 cursor-pointer ${
                        isSelected
                          ? 'bg-slate-900 border-cyan-400 shadow-lg shadow-cyan-950/50'
                          : node.enabled
                          ? 'bg-slate-900/60 hover:bg-slate-900 border-slate-800 text-slate-200'
                          : 'bg-slate-950/40 border-slate-900 text-slate-500 opacity-60'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex flex-col items-center gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveNodeOrder(idx, 'up');
                            }}
                            disabled={idx === 0}
                            className="p-1 hover:bg-slate-800 disabled:opacity-20 text-slate-400 hover:text-white rounded"
                          >
                            <ChevronUp size={13} />
                          </button>
                          <span className="text-xs font-mono font-bold text-cyan-400">#{idx + 1}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveNodeOrder(idx, 'down');
                            }}
                            disabled={idx === safeNodes.length - 1}
                            className="p-1 hover:bg-slate-800 disabled:opacity-20 text-slate-400 hover:text-white rounded"
                          >
                            <ChevronDown size={13} />
                          </button>
                        </div>

                        <div
                          className="p-2.5 rounded-xl shrink-0"
                          style={{ color: node.color, backgroundColor: `${node.color}20` }}
                        >
                          {getNodeIcon(node.iconName || 'Sparkles', 18)}
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-slate-100 truncate">{node.title}</span>
                            <span className="text-[10px] px-2 py-0.5 bg-slate-800 rounded text-slate-400 uppercase font-mono">
                              {node.category}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 truncate max-w-xl">{node.description}</p>
                          <div className="text-[10px] text-cyan-400/90 font-mono mt-1 flex items-center gap-3">
                            <span>Входы: {inputs.map((p) => p.label).join(', ') || 'Нет'}</span>
                            <span>•</span>
                            <span>Выходы: {outputs.map((p) => p.label).join(', ') || 'Нет'}</span>
                          </div>
                        </div>
                      </div>

                      {/* Действия над нодой */}
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={(e) => handleToggleNode(node.id, e)}
                          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                            node.enabled
                              ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-slate-800 text-slate-500 border border-slate-700'
                          }`}
                        >
                          {node.enabled ? 'Активна' : 'Байпас'}
                        </button>

                        <button
                          onClick={(e) => handleDeleteNode(node.id, e)}
                          className="p-2 hover:bg-rose-950/60 text-slate-500 hover:text-rose-400 rounded-xl transition-all"
                          title="Удалить ноду"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Правая часть: ИНСПЕКТОР ВЫБРАННОЙ НОДЫ ИЛИ ВЫБРАННОГО МАРШРУТА */}
          <div className="w-80 sm:w-96 bg-[#0f1422] border-l border-slate-800 flex flex-col p-5 space-y-4 overflow-y-auto shrink-0">
            {/* 1. Если выбран конкретный кабель/маршрут */}
            {selectedConnection ? (
              <div className="space-y-4">
                <div className="pb-3 border-b border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm">
                    <Link2 size={16} />
                    <span>Настройка маршрута</span>
                  </div>
                  <button
                    onClick={() => handleDeleteConnection(selectedConnection.id)}
                    className="p-1.5 hover:bg-rose-950/60 text-rose-400 rounded-lg transition-all"
                    title="Удалить этот маршрут"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs space-y-2">
                  <div className="flex items-center justify-between text-slate-400">
                    <span>Откуда:</span>
                    <strong className="text-cyan-300">
                      {safeNodes.find((n) => n.id === selectedConnection.fromNodeId)?.title}
                    </strong>
                  </div>
                  <div className="flex items-center justify-between text-slate-400">
                    <span>Выходной порт:</span>
                    <span className="font-mono text-emerald-400">{selectedConnection.fromPortId}</span>
                  </div>
                  <div className="border-t border-slate-800 pt-2 flex items-center justify-between text-slate-400">
                    <span>Куда:</span>
                    <strong className="text-purple-300">
                      {safeNodes.find((n) => n.id === selectedConnection.toNodeId)?.title}
                    </strong>
                  </div>
                  <div className="flex items-center justify-between text-slate-400">
                    <span>Входной порт:</span>
                    <span className="font-mono text-cyan-400">{selectedConnection.toPortId}</span>
                  </div>
                </div>

                <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs space-y-2">
                  <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!selectedConnection.isLoop}
                      onChange={(e) => {
                        selectedConnection.isLoop = e.target.checked;
                        globalRenderPipelineGraphManager.setGraph({ ...graph });
                        showToast(e.target.checked ? 'Маршрут переведен в Нодовую Петлю' : 'Обычный маршрут');
                      }}
                      className="accent-rose-500 rounded"
                    />
                    <span className="font-bold text-rose-300">Режим обратной связи (Feedback Loop)</span>
                  </label>
                  <p className="text-[10px] text-slate-400">
                    Позволяет возвращать аудиосигнал на повторный прогон через фильтры до достижения стандартов громкости.
                  </p>
                </div>

                <button
                  onClick={() => setSelectedConnId(null)}
                  className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Закрыть редактор связи
                </button>
              </div>
            ) : selectedNode ? (
              /* 2. Если выбрана нода */
              <>
                <div className="pb-3 border-b border-slate-800 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="p-2 rounded-xl"
                      style={{
                        color: selectedNode.color || '#06b6d4',
                        backgroundColor: `${selectedNode.color || '#06b6d4'}20`
                      }}
                    >
                      {getNodeIcon(selectedNode.iconName || 'Sparkles', 18)}
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-100">{selectedNode.title}</h3>
                      <p className="text-[11px] text-slate-400 font-mono">Категория: {selectedNode.category}</p>
                    </div>
                  </div>

                  <button
                    onClick={() => handleDeleteNode(selectedNode.id)}
                    className="p-1.5 hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 rounded-lg transition-all"
                    title="Удалить ноду"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Описание */}
                <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl text-xs text-slate-300">
                  {selectedNode.description}
                </div>

                {/* Переключатель статуса */}
                <div className="flex items-center justify-between p-3 bg-slate-950/80 border border-slate-800 rounded-xl text-xs">
                  <span className="font-semibold text-slate-300">Статус обработки:</span>
                  <button
                    onClick={() => handleToggleNode(selectedNode.id)}
                    className={`px-3 py-1 rounded-lg font-bold text-xs cursor-pointer transition-all ${
                      selectedNode.enabled
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    {selectedNode.enabled ? 'Включено (Run)' : 'Байпас (Bypass)'}
                  </button>
                </div>

                {/* УПРАВЛЕНИЕ ВХОДАМИ И ВЫХОДАМИ НОДЫ */}
                <div className="space-y-2 p-3 bg-slate-950/80 border border-slate-800 rounded-xl text-xs">
                  <h4 className="font-bold text-cyan-400 text-xs flex items-center justify-between">
                    <span>Маршруты и порты ноды:</span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {selectedNode.inputs.length} In / {selectedNode.outputs.length} Out
                    </span>
                  </h4>

                  {/* Активные входы */}
                  <div className="space-y-1">
                    <span className="text-[10px] text-slate-400 font-mono">Входящие сигналы:</span>
                    {selectedNode.inputs.map((p) => {
                      const incoming = safeConnections.filter(
                        (c) => c.toNodeId === selectedNode.id && c.toPortId === p.id
                      );
                      return (
                        <div key={p.id} className="p-1.5 bg-slate-900 rounded-lg flex items-center justify-between text-[11px]">
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color || '#10b981' }}></span>
                            <span>{p.label}</span>
                          </div>
                          <span className="text-[10px] text-cyan-400 font-mono">
                            {incoming.length > 0 ? `${incoming.length} подкл.` : 'Свободен'}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Активные выходы */}
                  <div className="space-y-1 pt-1">
                    <span className="text-[10px] text-slate-400 font-mono">Исходящие сигналы:</span>
                    {selectedNode.outputs.map((p) => {
                      const outgoing = safeConnections.filter(
                        (c) => c.fromNodeId === selectedNode.id && c.fromPortId === p.id
                      );
                      return (
                        <div key={p.id} className="p-1.5 bg-slate-900 rounded-lg flex items-center justify-between text-[11px]">
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color || '#06b6d4' }}></span>
                            <span>{p.label}</span>
                          </div>
                          <span className="text-[10px] text-emerald-400 font-mono">
                            {outgoing.length > 0 ? `${outgoing.length} цепей` : 'Свободен'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ПАРАМЕТРЫ СПЕЦИФИЧНЫХ НОД */}
                <div className="space-y-3 pt-1">
                  <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Sliders size={13} className="text-cyan-400" />
                    Параметры ноды:
                  </h4>

                  {/* Нода Готового Видео / FFmpeg Muxer с полными настройками качества */}
                  {(selectedNode.type === 'output_video' ||
                    selectedNode.type === 'ffmpeg_mux' ||
                    selectedNode.type === 'ffmpeg_dual_mux' ||
                    selectedNode.type === 'ffmpeg_single_mux') && (
                    <div className="space-y-3.5 p-3.5 bg-gradient-to-b from-slate-900 to-slate-950 border border-emerald-500/40 rounded-2xl text-xs shadow-xl">
                      {/* Заголовок секции */}
                      <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                        <div className="flex items-center gap-2 text-emerald-400 font-bold">
                          <Film size={16} />
                          <span>Настройки экспорта и качества видео</span>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 bg-emerald-950 text-emerald-300 border border-emerald-500/30 rounded-full font-mono uppercase">
                          {selectedNode.parameters.preset || 'lossless_original'}
                        </span>
                      </div>

                      {/* 1. БЫСТРЫЕ ПРЕСЕТЫ КАЧЕСТВА */}
                      <div>
                        <label className="block text-slate-300 text-[11px] font-semibold mb-1.5 flex items-center justify-between">
                          <span>Пресет экспорта видео:</span>
                          <span className="text-[10px] text-cyan-400 font-normal">Клик для автонастройки</span>
                        </label>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                          {[
                            {
                              id: 'lossless_original',
                              label: '🎬 Без потери качества',
                              sub: 'Как в оригинале (Copy)',
                              color: 'emerald'
                            },
                            {
                              id: 'uhd_4k_hq',
                              label: '🌟 4K Ultra HD',
                              sub: '2160p • 28 Mbps 2-Pass',
                              color: 'amber'
                            },
                            {
                              id: 'fhd_1080p_hq',
                              label: '💎 1080p HQ Студия',
                              sub: '1080p • 12 Mbps 2-Pass',
                              color: 'cyan'
                            },
                            {
                              id: 'fhd_1080p_fast',
                              label: '⚡ 1080p Fast',
                              sub: '1080p • 6 Mbps 1-Pass',
                              color: 'blue'
                            },
                            {
                              id: 'hd_720p_light',
                              label: '📱 720p Легкий',
                              sub: '720p • 2.5 Mbps CRF 23',
                              color: 'purple'
                            },
                            {
                              id: 'custom',
                              label: '🛠️ Свой режим',
                              sub: 'Ручная настройка',
                              color: 'slate'
                            }
                          ].map((p) => {
                            const isCurrent = (selectedNode.parameters.preset || 'lossless_original') === p.id;
                            return (
                              <button
                                key={p.id}
                                onClick={() => {
                                  const newParams = getExportParamsForPreset(
                                    p.id as VideoExportQualityPreset,
                                    selectedNode.parameters
                                  );
                                  handleUpdateMultipleParams(selectedNode.id, newParams);
                                  showToast(`Применен пресет видео: ${p.label}`);
                                }}
                                className={`p-2 rounded-xl text-left border transition-all cursor-pointer ${
                                  isCurrent
                                    ? 'bg-emerald-950/60 border-emerald-400 text-white shadow-md shadow-emerald-950/50'
                                    : 'bg-slate-900/80 hover:bg-slate-900 border-slate-800 text-slate-300'
                                }`}
                              >
                                <div className="font-bold text-[11px] truncate">{p.label}</div>
                                <div className="text-[9px] text-slate-400 truncate mt-0.5">{p.sub}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Информационная плашка активного пресета */}
                      <div className="p-2.5 bg-slate-950/90 border border-slate-800 rounded-xl text-[11px] text-slate-300 flex items-start gap-2">
                        <Info size={14} className="text-cyan-400 shrink-0 mt-0.5" />
                        <div>
                          {(selectedNode.parameters.preset || 'lossless_original') === 'lossless_original' && (
                            <span>
                              <strong>100% без потери качества:</strong> видеопоток копируется без повторного пересжатия (<strong>-c:v copy</strong>). Сохраняются оригинальное разрешение, битрейт, FPS и цветовой профиль оригинала без артефактов кодирования.
                            </span>
                          )}
                          {selectedNode.parameters.preset === 'uhd_4k_hq' && (
                            <span>
                              <strong>Ultra HD 4K:</strong> рендеринг в 3840x2160 с глубоким двухпроходным VBR кодированием (28 Mbps) и максимальной резкостью.
                            </span>
                          )}
                          {selectedNode.parameters.preset === 'fhd_1080p_hq' && (
                            <span>
                              <strong>1080p HQ Студия:</strong> двухпроходный 2-Pass VBR (12 Mbps / CRF 18) для вещательного качества и стриминга.
                            </span>
                          )}
                          {selectedNode.parameters.preset === 'fhd_1080p_fast' && (
                            <span>
                              <strong>1080p Fast:</strong> быстрый однопроходный x264 рендеринг (6 Mbps) для интернета и YouTube.
                            </span>
                          )}
                          {selectedNode.parameters.preset === 'hd_720p_light' && (
                            <span>
                              <strong>720p Легкий:</strong> оптимизирован для быстрой отправки в Telegram / мессенджеры (2.5 Mbps).
                            </span>
                          )}
                          {selectedNode.parameters.preset === 'custom' && (
                            <span>
                              <strong>Пользовательский режим:</strong> ручное управление разрешением, битрейтом, проходами (1-Pass / 2-Pass) и кодеками.
                            </span>
                          )}
                        </div>
                      </div>

                      {/* 2. БЛОК ВИДЕОПОТОКА */}
                      <div className="space-y-3 p-3 bg-slate-950/60 border border-slate-800 rounded-xl">
                        <div className="text-[11px] font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
                          <Film size={13} />
                          <span>Параметры видеопотока</span>
                        </div>

                        {/* Разрешение и Кодек */}
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-slate-400 text-[10px] mb-1">Разрешение видео:</label>
                            <select
                              value={selectedNode.parameters.resolution || 'original'}
                              onChange={(e) => {
                                handleUpdateParam(selectedNode.id, 'resolution', e.target.value);
                                if (e.target.value !== 'original' && selectedNode.parameters.videoCodec === 'copy') {
                                  handleUpdateParam(selectedNode.id, 'videoCodec', 'libx264');
                                  handleUpdateParam(selectedNode.id, 'preset', 'custom');
                                }
                              }}
                              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-xs focus:outline-none"
                            >
                              <option value="original">Как в оригинале (Original)</option>
                              <option value="3840x2160">3840x2160 (4K UHD)</option>
                              <option value="2560x1440">2560x1440 (2K QHD)</option>
                              <option value="1920x1080">1920x1080 (1080p FHD)</option>
                              <option value="1280x720">1280x720 (720p HD)</option>
                              <option value="854x480">854x480 (480p SD)</option>
                              <option value="custom">Пользовательское (WxH)</option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-slate-400 text-[10px] mb-1">Видеокодек:</label>
                            <select
                              value={selectedNode.parameters.videoCodec || 'copy'}
                              onChange={(e) => {
                                handleUpdateParam(selectedNode.id, 'videoCodec', e.target.value);
                                if (e.target.value === 'copy') {
                                  handleUpdateParam(selectedNode.id, 'preset', 'lossless_original');
                                  handleUpdateParam(selectedNode.id, 'resolution', 'original');
                                } else {
                                  handleUpdateParam(selectedNode.id, 'preset', 'custom');
                                }
                              }}
                              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-xs focus:outline-none"
                            >
                              <option value="copy">Direct Copy (Без пересжатия)</option>
                              <option value="libx264">H.264 / AVC (Макс. совместимость)</option>
                              <option value="libx265">H.265 / HEVC (Высокое сжатие)</option>
                              <option value="libvpx-vp9">VP9 (WebM / Open Video)</option>
                            </select>
                          </div>
                        </div>

                        {/* Кастомное разрешение W x H */}
                        {selectedNode.parameters.resolution === 'custom' && (
                          <div className="grid grid-cols-2 gap-2 p-2 bg-slate-900/90 rounded-lg border border-slate-800">
                            <div>
                              <label className="block text-slate-400 text-[10px] mb-1">Ширина (Width):</label>
                              <input
                                type="number"
                                placeholder="1920"
                                value={selectedNode.parameters.customResolutionWidth || 1920}
                                onChange={(e) =>
                                  handleUpdateParam(selectedNode.id, 'customResolutionWidth', parseInt(e.target.value) || 1920)
                                }
                                className="w-full px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs"
                              />
                            </div>
                            <div>
                              <label className="block text-slate-400 text-[10px] mb-1">Высота (Height):</label>
                              <input
                                type="number"
                                placeholder="1080"
                                value={selectedNode.parameters.customResolutionHeight || 1080}
                                onChange={(e) =>
                                  handleUpdateParam(selectedNode.id, 'customResolutionHeight', parseInt(e.target.value) || 1080)
                                }
                                className="w-full px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs"
                              />
                            </div>
                          </div>
                        )}

                        {/* Проходы кодирования: 1-Pass vs 2-Pass */}
                        {selectedNode.parameters.videoCodec !== 'copy' && (
                          <div className="space-y-2 pt-1 border-t border-slate-800/80">
                            <label className="block text-slate-400 text-[10px]">Количество проходов кодирования:</label>
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  handleUpdateParam(selectedNode.id, 'encodingPasses', 1);
                                  handleUpdateParam(selectedNode.id, 'preset', 'custom');
                                }}
                                className={`py-1.5 px-2 rounded-xl text-xs font-semibold border text-center transition-all cursor-pointer ${
                                  (selectedNode.parameters.encodingPasses || 1) === 1
                                    ? 'bg-cyan-950/80 border-cyan-400 text-cyan-200'
                                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                                }`}
                              >
                                ⚡ 1-Pass (Однопроходный)
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  handleUpdateParam(selectedNode.id, 'encodingPasses', 2);
                                  handleUpdateParam(selectedNode.id, 'preset', 'custom');
                                }}
                                className={`py-1.5 px-2 rounded-xl text-xs font-semibold border text-center transition-all cursor-pointer ${
                                  selectedNode.parameters.encodingPasses === 2
                                    ? 'bg-purple-950/80 border-purple-400 text-purple-200'
                                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                                }`}
                              >
                                💎 2-Pass (Двухпроходный VBR)
                              </button>
                            </div>
                            <p className="text-[10px] text-slate-500">
                              {selectedNode.parameters.encodingPasses === 2
                                ? 'Двухпроходный режим: 1-й проход анализирует динамику сцен, 2-й проход идеально распределяет битрейт для наилучшего студийного качества.'
                                : 'Однопроходный режим: быстрое кодирование с минимальной нагрузкой.'}
                            </p>
                          </div>
                        )}

                        {/* Битрейт видео и CRF */}
                        {selectedNode.parameters.videoCodec !== 'copy' && (
                          <div className="space-y-2 pt-1 border-t border-slate-800/80">
                            <div className="flex items-center justify-between">
                              <label className="text-slate-400 text-[10px]">Режим контроля битрейта:</label>
                              <select
                                value={selectedNode.parameters.rateControl || 'vbr'}
                                onChange={(e) => handleUpdateParam(selectedNode.id, 'rateControl', e.target.value)}
                                className="px-2 py-0.5 bg-slate-900 border border-slate-700 rounded text-slate-200 text-[11px]"
                              >
                                <option value="vbr">VBR (Переменный битрейт)</option>
                                <option value="crf">CRF (Постоянное качество)</option>
                                <option value="cbr">CBR (Постоянный битрейт)</option>
                              </select>
                            </div>

                            {selectedNode.parameters.rateControl === 'crf' ? (
                              <div>
                                <div className="flex justify-between text-slate-300 text-[11px] mb-1">
                                  <span>CRF фактор качества:</span>
                                  <strong className="text-cyan-400 font-mono">
                                    CRF {selectedNode.parameters.crf ?? 18}{' '}
                                    <span className="text-[10px] text-slate-400">
                                      {(selectedNode.parameters.crf ?? 18) <= 16
                                        ? '(Ультра-качество)'
                                        : (selectedNode.parameters.crf ?? 18) <= 19
                                        ? '(Визуально без потерь)'
                                        : (selectedNode.parameters.crf ?? 18) <= 24
                                        ? '(Стандарт)'
                                        : '(Высокое сжатие)'}
                                    </span>
                                  </strong>
                                </div>
                                <input
                                  type="range"
                                  min="12"
                                  max="32"
                                  step="1"
                                  value={selectedNode.parameters.crf ?? 18}
                                  onChange={(e) =>
                                    handleUpdateParam(selectedNode.id, 'crf', parseInt(e.target.value))
                                  }
                                  className="w-full accent-cyan-400 cursor-pointer"
                                />
                              </div>
                            ) : (
                              <div>
                                <div className="flex justify-between text-slate-300 text-[11px] mb-1">
                                  <span>Целевой битрейт видео:</span>
                                  <strong className="text-emerald-400 font-mono">
                                    {Math.round((selectedNode.parameters.videoBitrateKbps || 12000) / 1000)} Mbps{' '}
                                    <span className="text-[10px] text-slate-400">
                                      ({selectedNode.parameters.videoBitrateKbps || 12000} kbps)
                                    </span>
                                  </strong>
                                </div>
                                <input
                                  type="range"
                                  min="1500"
                                  max="40000"
                                  step="500"
                                  value={selectedNode.parameters.videoBitrateKbps || 12000}
                                  onChange={(e) =>
                                    handleUpdateParam(selectedNode.id, 'videoBitrateKbps', parseInt(e.target.value))
                                  }
                                  className="w-full accent-emerald-400 cursor-pointer"
                                />
                                <div className="flex gap-1.5 mt-1.5">
                                  {[2500, 6000, 12000, 20000, 28000].map((b) => (
                                    <button
                                      key={b}
                                      type="button"
                                      onClick={() => handleUpdateParam(selectedNode.id, 'videoBitrateKbps', b)}
                                      className={`flex-1 py-0.5 text-[9px] font-mono rounded border ${
                                        selectedNode.parameters.videoBitrateKbps === b
                                          ? 'bg-emerald-950 border-emerald-400 text-emerald-300 font-bold'
                                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                                      }`}
                                    >
                                      {b / 1000}M
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* FPS и Профиль */}
                            <div className="grid grid-cols-2 gap-2 pt-1">
                              <div>
                                <label className="block text-slate-400 text-[10px] mb-1">Частота кадров (FPS):</label>
                                <select
                                  value={selectedNode.parameters.fps || 'original'}
                                  onChange={(e) => handleUpdateParam(selectedNode.id, 'fps', e.target.value)}
                                  className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-slate-200 text-[11px]"
                                >
                                  <option value="original">Как в оригинале</option>
                                  <option value="60">60 FPS</option>
                                  <option value="59.94">59.94 FPS</option>
                                  <option value="30">30 FPS</option>
                                  <option value="29.97">29.97 FPS</option>
                                  <option value="25">25 FPS (PAL)</option>
                                  <option value="24">24 FPS (Кино)</option>
                                  <option value="23.976">23.976 FPS</option>
                                </select>
                              </div>

                              <div>
                                <label className="block text-slate-400 text-[10px] mb-1">Скорость x264:</label>
                                <select
                                  value={selectedNode.parameters.encoderSpeedPreset || 'medium'}
                                  onChange={(e) =>
                                    handleUpdateParam(selectedNode.id, 'encoderSpeedPreset', e.target.value)
                                  }
                                  className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-slate-200 text-[11px]"
                                >
                                  <option value="ultrafast">ultrafast (Мгновенно)</option>
                                  <option value="veryfast">veryfast (Быстро)</option>
                                  <option value="fast">fast</option>
                                  <option value="medium">medium (Баланс)</option>
                                  <option value="slow">slow (Высокое качество)</option>
                                  <option value="slower">slower (Максимум)</option>
                                </select>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 3. БЛОК АУДИОПОТОКА В ВИДЕО */}
                      <div className="space-y-3 p-3 bg-slate-950/60 border border-slate-800 rounded-xl">
                        <div className="text-[11px] font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-1.5">
                          <Volume2 size={13} />
                          <span>Параметры аудиопотока в видео</span>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-slate-400 text-[10px] mb-1">Битрейт аудио (AAC):</label>
                            <select
                              value={selectedNode.parameters.audioBitrate || '320k'}
                              onChange={(e) => handleUpdateParam(selectedNode.id, 'audioBitrate', e.target.value)}
                              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-xs focus:outline-none"
                            >
                              <option value="320k">320 kbps (Студийный мастер)</option>
                              <option value="256k">256 kbps (Стандарт вещания)</option>
                              <option value="192k">192 kbps (Оптимальный)</option>
                              <option value="128k">128 kbps (Экономный)</option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-slate-400 text-[10px] mb-1">Формат контейнера:</label>
                            <select
                              value={selectedNode.parameters.container || 'mp4'}
                              onChange={(e) => handleUpdateParam(selectedNode.id, 'container', e.target.value)}
                              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-xs focus:outline-none"
                            >
                              <option value="mp4">MP4 (.mp4 — универсальный)</option>
                              <option value="mkv">MKV (.mkv — мультитрек)</option>
                              <option value="mov">MOV (.mov — Apple QuickTime)</option>
                              <option value="webm">WebM (.webm — Web)</option>
                            </select>
                          </div>
                        </div>

                        {/* Названия дорожек */}
                        <div className="space-y-2 pt-1">
                          <div>
                            <label className="block text-slate-400 text-[10px] mb-1">Дорожка 1 (Дубляж / Мастер):</label>
                            <input
                              type="text"
                              value={selectedNode.parameters.track1Title || 'Дубляж / Dubbed Mix'}
                              onChange={(e) => handleUpdateParam(selectedNode.id, 'track1Title', e.target.value)}
                              className="w-full px-2.5 py-1 bg-slate-900 border border-slate-700 rounded text-slate-200 text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block text-slate-400 text-[10px] mb-1">Дорожка 2 (Оригинал):</label>
                            <input
                              type="text"
                              value={selectedNode.parameters.track2Title || 'Оригинал / Original Audio'}
                              onChange={(e) => handleUpdateParam(selectedNode.id, 'track2Title', e.target.value)}
                              className="w-full px-2.5 py-1 bg-slate-900 border border-slate-700 rounded text-slate-200 text-[11px]"
                            />
                          </div>
                        </div>
                      </div>

                      {/* 4. ОПЦИИ СКАЧИВАНИЯ И WEB FASTSTART */}
                      <div className="space-y-2 p-3 bg-slate-950/60 border border-slate-800 rounded-xl text-xs">
                        <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedNode.parameters.fastStart !== false}
                            onChange={(e) => handleUpdateParam(selectedNode.id, 'fastStart', e.target.checked)}
                            className="accent-emerald-500 rounded"
                          />
                          <span>Web FastStart (перенос moov-атома в начало файла для мгновенного онлайн-воспроизведения)</span>
                        </label>
                        <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedNode.parameters.autoDownload !== false}
                            onChange={(e) => handleUpdateParam(selectedNode.id, 'autoDownload', e.target.checked)}
                            className="accent-emerald-500 rounded"
                          />
                          <span>Автоматически скачивать готовый файл на диск после рендеринга</span>
                        </label>
                      </div>

                      {/* 5. FFmpeg Live Command Preview */}
                      <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-xl space-y-1 font-mono text-[10px]">
                        <div className="text-cyan-400 font-bold flex items-center gap-1.5">
                          <Terminal size={12} />
                          <span>Команда FFmpeg для этой конфигурации:</span>
                        </div>
                        <div className="text-emerald-300/90 break-all p-1.5 bg-slate-900/80 rounded border border-slate-800/60">
                          ffmpeg -i input_video.mp4 -i audio_mix.wav{' '}
                          {selectedNode.parameters.videoCodec === 'copy' || (selectedNode.parameters.preset || 'lossless_original') === 'lossless_original'
                            ? '-c:v copy'
                            : `-c:v ${selectedNode.parameters.videoCodec || 'libx264'} ${
                                selectedNode.parameters.resolution && selectedNode.parameters.resolution !== 'original'
                                  ? `-vf scale=${selectedNode.parameters.resolution} `
                                  : ''
                              }${
                                selectedNode.parameters.encodingPasses === 2 ? '-pass 2 ' : ''
                              }-b:v ${selectedNode.parameters.videoBitrateKbps || 12000}k`}{' '}
                          -c:a {selectedNode.parameters.audioCodec || 'aac'} -b:a {selectedNode.parameters.audioBitrate || '320k'} -movflags +faststart output.{selectedNode.parameters.container || 'mp4'}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Нода Сохранения на диск (WAV / MP3) */}
                  {(selectedNode.type === 'disk_save_wav' || selectedNode.type === 'disk_save_mp3') && (
                    <div className="space-y-3 p-3 bg-emerald-950/20 border border-emerald-500/30 rounded-xl text-xs">
                      <div className="flex items-center gap-1.5 text-emerald-300 font-bold">
                        <HardDrive size={14} />
                        <span>Авто-сброс на жесткий диск</span>
                      </div>
                      <div>
                        <label className="block text-slate-400 text-[11px] mb-1">Шаблон имени файла:</label>
                        <input
                          type="text"
                          value={selectedNode.parameters.fileNamePattern || 'export_mix.wav'}
                          onChange={(e) => handleUpdateParam(selectedNode.id, 'fileNamePattern', e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-xs focus:outline-none"
                        />
                      </div>
                      <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!selectedNode.parameters.autoDownload}
                          onChange={(e) => handleUpdateParam(selectedNode.id, 'autoDownload', e.target.checked)}
                          className="accent-emerald-500 rounded"
                        />
                        <span>Автоматически скачивать браузером</span>
                      </label>
                    </div>
                  )}

                  {/* Нода Отшивания (Mute / Isolator) */}
                  {selectedNode.type === 'track_isolator_mute' && (
                    <div className="space-y-3 p-3 bg-rose-950/20 border border-rose-500/30 rounded-xl text-xs">
                      <div>
                        <label className="block text-slate-400 text-[11px] mb-1">Режим отшивания:</label>
                        <select
                          value={selectedNode.parameters.mode || 'mute_when_active'}
                          onChange={(e) => handleUpdateParam(selectedNode.id, 'mode', e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-xs focus:outline-none"
                        >
                          <option value="mute_when_active">Mute при наличии сигнала триггера</option>
                          <option value="isolate_only">Изолировать только эту дорожку</option>
                          <option value="bypass_subchain">Байпас всей последующей ветки</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Нода Петли (Feedback Loop) */}
                  {selectedNode.type === 'feedback_loop' && (
                    <div className="space-y-3 p-3 bg-rose-950/20 border border-rose-500/30 rounded-xl text-xs">
                      <div>
                        <div className="flex justify-between text-slate-300 mb-1">
                          <span>Количество проходов (Loop Passes):</span>
                          <strong className="text-rose-400 font-mono">
                            {selectedNode.parameters.iterations || 2}x
                          </strong>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="4"
                          step="1"
                          value={selectedNode.parameters.iterations || 2}
                          onChange={(e) =>
                            handleUpdateParam(selectedNode.id, 'iterations', parseInt(e.target.value))
                          }
                          className="w-full accent-rose-500 cursor-pointer"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-400 text-[11px] mb-1">Условие выхода из петли:</label>
                        <select
                          value={selectedNode.parameters.condition || 'target_lufs_reached'}
                          onChange={(e) => handleUpdateParam(selectedNode.id, 'condition', e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-xs focus:outline-none"
                        >
                          <option value="target_lufs_reached">Достижение целевого уровня LUFS</option>
                          <option value="fixed_iterations">Фиксированное число проходов</option>
                          <option value="delta_minimized">Минимизация дельты громкости</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Параметры Сплиттера / Разветвителя */}
                  {selectedNode.type === 'node_branch_split' && (
                    <div className="space-y-2 p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs">
                      <div className="text-slate-300 font-semibold">Число параллельных веток:</div>
                      <div className="text-[11px] text-slate-400">
                        Нода автоматически дублирует входящий сигнал на 3 независимых выхода (Direct, FX/AI, Sidechain).
                      </div>
                    </div>
                  )}

                  {/* Параметры FFmpeg WASM Muxer */}
                  {(selectedNode.type === 'ffmpeg_mux' || selectedNode.type === 'ffmpeg_dual_mux') && (
                    <div className="space-y-3 p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs">
                      <div>
                        <label className="block text-slate-400 text-[11px] mb-1">Битрейт аудио (AAC):</label>
                        <select
                          value={selectedNode.parameters.audioBitrate || '320k'}
                          onChange={(e) => handleUpdateParam(selectedNode.id, 'audioBitrate', e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-200 text-xs focus:outline-none"
                        >
                          <option value="320k">320 kbps (Студийное качество)</option>
                          <option value="256k">256 kbps (Стандарт вещания)</option>
                          <option value="192k">192 kbps (Оптимальный)</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Общий JSON-параметризатор для кастомных настроек */}
                  <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1 text-xs">
                    <div className="text-[10px] font-mono text-slate-400">Сырые параметры ноды (JSON):</div>
                    <pre className="text-[10px] font-mono text-cyan-300/80 overflow-x-auto p-1 bg-slate-900 rounded">
                      {JSON.stringify(selectedNode.parameters, null, 2)}
                    </pre>
                  </div>
                </div>
              </>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 text-xs p-4">
                <Sliders size={28} className="mb-2 opacity-40 text-cyan-400" />
                <p>Выберите любую ноду или маршрут на холсте для настройки параметров и связей.</p>
              </div>
            )}
          </div>
        </div>

        {/* 4. НИЖНИЙ ПОДВАЛ С КНОПКАМИ */}
        <div className="px-5 py-3.5 bg-[#0f1422] border-t border-slate-800 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Info size={14} className="text-cyan-400 shrink-0" />
            <span>
              Нодовый граф с портами автоматически сохраняется в ваших пресетах [<strong>{activeCategory}</strong>].
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
            >
              Закрыть
            </button>
            <button
              onClick={() => {
                onClose();
                onRunPipeline();
              }}
              className="px-5 py-2 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white font-bold rounded-xl text-xs flex items-center gap-2 cursor-pointer shadow-lg shadow-emerald-950/50"
            >
              <Sparkles size={15} className="text-amber-300" />
              <span>Свести и сохранить готовое видео</span>
            </button>
          </div>
        </div>
      </div>

      {/* Toast-уведомление */}
      {notification && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-emerald-950/90 border border-emerald-500/50 text-emerald-200 px-4 py-2 rounded-xl text-xs font-semibold shadow-2xl flex items-center gap-2 animate-fadeIn z-50">
          <CheckCircle2 size={15} className="text-emerald-400" />
          <span>{notification}</span>
        </div>
      )}
    </div>
  );
};
