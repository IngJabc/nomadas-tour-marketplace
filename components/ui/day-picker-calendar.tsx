'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type TableHTMLAttributes,
} from 'react';
import { DayPicker, useDayPicker } from 'react-day-picker';
import { es } from 'date-fns/locale';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export type DayPickerCalendarSize = 'default' | 'comfortable';

const MonthNavContext = createContext<React.MutableRefObject<number> | null>(null);

const monthSlideVariants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 20 }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: direction * -20 }),
};

const navButtonClassName =
  'inline-flex items-center justify-center rounded-lg border border-[rgba(0,0,0,0.06)] bg-white text-[var(--color-brand-muted)] hover:bg-[#f1f5f9] hover:text-[var(--color-brand-navy)] transition-colors cursor-pointer z-10 focus-visible:outline-2 focus-visible:outline-[var(--color-brand-cyan)] focus-visible:outline-offset-1 disabled:opacity-40 disabled:cursor-not-allowed';

function HiddenChevron() {
  return <span className="sr-only" aria-hidden />;
}

function PreviousMonthButton({ className, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const directionRef = useContext(MonthNavContext);
  return (
    <button
      type="button"
      {...props}
      className={cn(navButtonClassName, className)}
      onClick={(e) => {
        if (directionRef) directionRef.current = -1;
        onClick?.(e);
      }}
    >
      <ChevronLeft className="w-4 h-4 pointer-events-none" strokeWidth={1.75} />
    </button>
  );
}

function NextMonthButton({ className, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const directionRef = useContext(MonthNavContext);
  return (
    <button
      type="button"
      {...props}
      className={cn(navButtonClassName, className)}
      onClick={(e) => {
        if (directionRef) directionRef.current = 1;
        onClick?.(e);
      }}
    >
      <ChevronRight className="w-4 h-4 pointer-events-none" strokeWidth={1.75} />
    </button>
  );
}

function AnimatedMonthGrid(props: TableHTMLAttributes<HTMLTableElement>) {
  const directionRef = useContext(MonthNavContext);
  const { months } = useDayPicker();
  const monthKey = months[0]
    ? `${months[0].date.getFullYear()}-${months[0].date.getMonth()}`
    : 'empty';
  const direction = directionRef?.current ?? 0;

  return (
    <motion.div
      layout
      transition={{ duration: 0.2, ease: 'easeInOut' }}
      className="overflow-hidden w-full"
    >
      <AnimatePresence mode="wait" custom={direction}>
        <motion.div
          key={monthKey}
          custom={direction}
          variants={monthSlideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.2, ease: 'easeInOut' }}
        >
          <table {...props} className={cn(props.className, 'w-full border-collapse')} />
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

function getDayPickerClassNames(size: DayPickerCalendarSize) {
  const daySize =
    size === 'comfortable'
      ? 'w-10 h-10 sm:w-11 sm:h-11 text-sm'
      : 'w-9 h-9 text-sm';

  const navSize =
    size === 'comfortable'
      ? 'absolute left-0 top-0 w-10 h-10 min-w-10 min-h-10'
      : 'absolute left-0 top-0 w-11 h-11 min-w-11 min-h-11 sm:w-8 sm:h-8 sm:min-w-8 sm:min-h-8';

  const navSizeNext =
    size === 'comfortable'
      ? 'absolute right-0 top-0 w-10 h-10 min-w-10 min-h-10'
      : 'absolute right-0 top-0 w-11 h-11 min-w-11 min-h-11 sm:w-8 sm:h-8 sm:min-w-8 sm:min-h-8';

  return {
    root: 'w-fit max-w-full mx-auto font-[family-name:var(--font-body)]',
    months: size === 'comfortable' ? 'w-full' : 'relative flex flex-col',
    month: 'relative w-full max-w-full',
    month_caption: cn(
      'relative flex items-center justify-center mb-3',
      size === 'comfortable' ? 'min-h-10' : 'min-h-11 sm:min-h-8',
    ),
    caption_label: cn(
      'font-[family-name:var(--font-heading)] font-bold text-[var(--color-brand-navy)] capitalize text-center pointer-events-none select-none',
      size === 'comfortable' ? 'px-12 text-sm' : 'px-12 text-sm',
    ),
    button_previous: navSize,
    button_next: navSizeNext,
    weekdays: cn('grid grid-cols-7 mb-1', size === 'comfortable' && 'gap-0.5'),
    weekday: cn(
      'font-[family-name:var(--font-body)] font-medium text-[var(--color-brand-muted)] uppercase text-center',
      size === 'comfortable' ? 'text-xs py-1.5' : 'text-[11px] py-1',
    ),
    weeks: cn('flex flex-col', size === 'comfortable' ? 'gap-1' : 'gap-0.5'),
    week: cn('grid grid-cols-7', size === 'comfortable' && 'gap-0.5'),
    day: 'p-0 text-center',
    day_button: cn(
      'mx-auto rounded-lg font-[family-name:var(--font-body)] text-[var(--color-brand-navy)]',
      daySize,
      'hover:bg-[rgba(0,212,255,0.1)] transition-colors duration-150',
      'focus-visible:outline-2 focus-visible:outline-[var(--color-brand-cyan)] focus-visible:outline-offset-1',
      'disabled:opacity-30 disabled:cursor-not-allowed',
    ),
    selected:
      '[&>button]:bg-[var(--color-brand-cyan)] [&>button]:text-white [&>button]:font-semibold [&>button]:hover:bg-[var(--color-brand-blue)]',
    today: '[&>button]:border [&>button]:border-[var(--color-brand-cyan)]',
    outside: '[&>button]:text-[var(--color-brand-muted)] [&>button]:opacity-50',
    disabled: '[&>button]:opacity-30 [&>button]:cursor-not-allowed',
  };
}

type DayPickerCalendarProps = {
  size?: DayPickerCalendarSize;
  selected?: Date;
  onSelect?: (date: Date | undefined) => void;
  defaultMonth?: Date;
  disabled?: boolean;
};

export function DayPickerCalendar({
  size = 'default',
  selected,
  onSelect,
  defaultMonth,
  disabled,
}: DayPickerCalendarProps) {
  const directionRef = useRef(0);
  const [month, setMonth] = useState<Date>(() => defaultMonth ?? selected ?? new Date());

  const handleMonthChange = useCallback((nextMonth: Date) => {
    setMonth(nextMonth);
  }, []);

  const classNames = useMemo(() => getDayPickerClassNames(size), [size]);

  return (
    <MonthNavContext.Provider value={directionRef}>
      <DayPicker
        mode="single"
        locale={es}
        navLayout="around"
        month={month}
        onMonthChange={handleMonthChange}
        selected={selected}
        onSelect={onSelect}
        defaultMonth={defaultMonth}
        disabled={disabled}
        showOutsideDays
        classNames={classNames}
        components={{
          PreviousMonthButton,
          NextMonthButton,
          Chevron: HiddenChevron,
          MonthGrid: AnimatedMonthGrid,
        }}
      />
    </MonthNavContext.Provider>
  );
}
