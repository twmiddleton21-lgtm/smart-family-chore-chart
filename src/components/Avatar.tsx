import type { Child } from '../types';

interface AvatarProps {
  child: Pick<Child, 'avatar' | 'color'>;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

/** Emoji avatar in a coloured circle. Decorative: names are always shown alongside. */
export function Avatar({ child, size = 'md' }: AvatarProps) {
  return (
    <span className={`avatar avatar-${size} accent-${child.color}`} aria-hidden="true">
      {child.avatar}
    </span>
  );
}
