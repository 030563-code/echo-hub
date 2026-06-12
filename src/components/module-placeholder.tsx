import type { LucideIcon } from 'lucide-react'

interface ModulePlaceholderProps {
  title: string
  icon: LucideIcon
  phase: string
  description: string
}

/** Standard "module not built yet" panel for workstream pages still on the roadmap. */
export function ModulePlaceholder({ title, icon: Icon, phase, description }: ModulePlaceholderProps) {
  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-2">
        <Icon className="w-7 h-7 text-echo-orange" />
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
      </div>
      <span className="inline-block text-xs font-bold uppercase tracking-wider text-echo-orange bg-echo-orange/10 px-2 py-1 rounded mb-6">
        {phase}
      </span>
      <p className="text-gray-600 leading-relaxed">{description}</p>
      <div className="mt-8 rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-gray-400">
        This module is scaffolded and access-gated. Its UI lands in a later phase.
      </div>
    </div>
  )
}
