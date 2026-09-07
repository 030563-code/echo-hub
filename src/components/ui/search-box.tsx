"use client";

import { Search, X } from "lucide-react";

// Small controlled search input, themed for light + dark surfaces. Callers keep
// the query in state and filter their rows client-side.
export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
  dark = false,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  dark?: boolean;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search
        className={`pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 ${
          dark ? "text-[#4b5563]" : "text-gray-400"
        }`}
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full sm:w-64 pl-8 pr-8 py-1.5 text-sm rounded-lg border focus:outline-none focus:border-[#FF7026] ${
          dark ? "bg-[#1a1a1a] border-[#2a2a2a] text-[#e5e5e5] placeholder:text-[#4b5563]" : "bg-white border-gray-200 text-gray-800 placeholder:text-gray-400"
        }`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className={`absolute right-2 top-1/2 -translate-y-1/2 ${dark ? "text-[#4b5563] hover:text-[#e5e5e5]" : "text-gray-400 hover:text-gray-700"}`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
