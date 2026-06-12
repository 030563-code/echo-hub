import { cn } from "@/lib/utils";

interface TrafficLightProps {
  status: "green" | "yellow" | "red";
  label?: string;
  size?: "sm" | "md";
}

const CONFIG = {
  green:  { dot: "bg-emerald-400 shadow-emerald-400/50", text: "text-emerald-300", label: "OK" },
  yellow: { dot: "bg-yellow-400 shadow-yellow-400/50",   text: "text-yellow-300",  label: "Watch" },
  red:    { dot: "bg-red-400 shadow-red-400/50",         text: "text-red-300",     label: "Manufacture Now" },
};

export default function TrafficLight({ status, label, size = "sm" }: TrafficLightProps) {
  const { dot, text } = CONFIG[status];
  const dotSize = size === "md" ? "w-3 h-3" : "w-2 h-2";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("rounded-full shadow-lg flex-shrink-0", dot, dotSize)} />
      <span className={cn("font-medium", text, size === "md" ? "text-sm" : "text-xs")}>
        {label ?? CONFIG[status].label}
      </span>
    </span>
  );
}
