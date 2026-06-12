import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg' | 'icon';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'primary', size = 'md', ...props }, ref) => {
    const baseStyles =
      'font-bold transition-all focus:outline-none focus:ring-2 disabled:opacity-50 disabled:cursor-not-allowed rounded-[5px] cursor-pointer';

    const variants = {
      primary: 'bg-echo-orange text-white hover:bg-echo-orange-hover focus:ring-echo-orange/40',
      secondary: 'bg-echo-dark text-white hover:bg-[#4a4948] focus:ring-echo-dark/40',
      outline:
        'bg-transparent text-echo-orange border border-echo-orange hover:bg-echo-orange hover:text-white focus:ring-echo-orange/40',
      danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500/40',
      ghost: 'bg-transparent text-gray-500 hover:text-echo-dark hover:bg-gray-100 focus:ring-gray-300/40',
    };

    const sizes = {
      sm: 'px-4 py-2 text-xs',
      md: 'px-5 py-2.5 text-sm',
      lg: 'px-6 py-3 text-base',
      icon: 'h-10 w-10 p-0 flex items-center justify-center',
    };

    return (
      <button
        ref={ref}
        className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
