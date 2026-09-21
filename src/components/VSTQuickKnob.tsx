import React, { useRef, useState, useEffect } from 'react';

interface VSTQuickKnobProps {
  id: string;
  name: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  color?: string;
  size?: number;
  onChange: (val: number) => void;
}

export const VSTQuickKnob: React.FC<VSTQuickKnobProps> = ({
  id,
  name,
  value,
  min,
  max,
  step = 0.01,
  unit = '',
  color = '#06b6d4',
  size = 36,
  onChange
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef<number>(0);
  const startValRef = useRef<number>(value);
  const currentValRef = useRef<number>(value);

  useEffect(() => {
    currentValRef.current = value;
  }, [value]);

  const norm = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
  // 270 degrees sweep (-135 to +135)
  const angle = -135 + norm * 270;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsDragging(true);
    startYRef.current = e.clientY;
    startValRef.current = currentValRef.current;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startYRef.current - moveEvent.clientY;
      const range = max - min;
      const speed = moveEvent.shiftKey ? 0.001 : 0.005;
      let nextVal = startValRef.current + deltaY * range * speed;
      nextVal = Math.max(min, Math.min(max, nextVal));
      if (step) {
        nextVal = Math.round(nextVal / step) * step;
      }
      currentValRef.current = nextVal;
      onChange(nextVal);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const defaultVal = min + (max - min) * 0.5;
    currentValRef.current = defaultVal;
    onChange(defaultVal);
  };

  return (
    <div
      id={`vst-quick-knob-${id}`}
      className="flex flex-col items-center select-none group cursor-ns-resize"
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      title={`${name}: ${value.toFixed(1)}${unit} (тяните вверх/вниз для изменения, Shift для точной настройки, 2 клика для сброса)`}
    >
      <div
        className="relative rounded-full bg-slate-950 border border-slate-700/80 shadow-inner flex items-center justify-center transition-transform active:scale-95"
        style={{ width: size, height: size }}
      >
        {/* Ring track */}
        <svg className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none" viewBox="0 0 36 36">
          <circle
            cx="18"
            cy="18"
            r="14"
            fill="none"
            stroke="#1e293b"
            strokeWidth="3"
            strokeDasharray="65.97 87.96"
            strokeDashoffset="-10.99"
          />
          <circle
            cx="18"
            cy="18"
            r="14"
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeDasharray={`${norm * 65.97} 87.96`}
            strokeDashoffset="-10.99"
            strokeLinecap="round"
          />
        </svg>

        {/* Center cap with pointer line */}
        <div
          className="w-5 h-5 rounded-full bg-slate-900 border border-slate-750 flex items-center justify-center relative shadow-sm"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div
            className="absolute top-0.5 w-0.5 h-2 rounded-full"
            style={{ backgroundColor: isDragging ? '#ffffff' : color }}
          />
        </div>
      </div>

      <span className="text-[9px] font-semibold text-slate-400 group-hover:text-slate-200 truncate max-w-[48px] mt-1">
        {name}
      </span>
      <span className="text-[9px] font-mono text-cyan-400/90 -mt-0.5">
        {value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(value < 10 && value > -10 && value !== 0 ? 1 : 0)}
        {unit}
      </span>
    </div>
  );
};
