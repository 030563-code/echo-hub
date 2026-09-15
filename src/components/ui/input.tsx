import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', label, error, id, ...props }, ref) => {
    // The label has to point at the input. Without it a screen reader announces
    // an unlabelled box, and a password manager loses one of the signals it uses
    // to work out what the field is for.
    const generatedId = React.useId();
    const inputId = id ?? generatedId;

    return (
      <div className="w-full">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-echo-dark mb-1">
            {label}
          </label>
        )}
        <input
          id={inputId}
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
Input.displayName = 'Input';
