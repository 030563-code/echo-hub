import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', label, error, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-medium text-echo-dark mb-1">{label}</label>
        )}
        <input
          ref={ref}
          className={`
            w-full bg-white border-b-2 border-echo-border text-echo-dark px-0 py-2.5
            focus:outline-none focus:border-echo-orange
            placeholder-gray-400 transition-colors text-sm
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
Input.displayName = 'Input';
