import React from 'react';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', label, error, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-medium text-echo-dark mb-1">{label}</label>
        )}
        <textarea
          ref={ref}
          className={`
            w-full bg-white border-b-2 border-echo-border text-echo-dark px-0 py-2.5
            focus:outline-none focus:border-echo-orange
            placeholder-gray-400 transition-colors text-base sm:text-sm
            disabled:bg-transparent disabled:text-gray-400
            ${error ? 'border-red-500 focus:border-red-500' : ''}
            ${className}
          `}
          {...props}
        />
        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>
    );
  }
);
Textarea.displayName = 'Textarea';
