import React from 'react';
import { cn } from '@/lib/utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  description?: string;
}

export const Card = ({ children, className = '', title, description }: CardProps) => {
  return (
    // cn() is twMerge: a caller passing p-0 or bg-white MEANS it. Plain string
    // interpolation left both classes in play and Tailwind's own ordering
    // decided the winner, so overrides were silently ignored.
    <div className={cn('bg-[#1a1a1a] border border-gray-800 p-8', className)}>
      {(title || description) && (
        <div className="mb-6 border-b border-gray-800 pb-4">
          {title && (
            <h2 className="text-xl font-bold text-white uppercase tracking-wider">{title}</h2>
          )}
          {description && <p className="text-sm text-gray-500 mt-1">{description}</p>}
        </div>
      )}
      {children}
    </div>
  );
};
