// Minimal React typings used ONLY where @types/react is not installed (offline build environment).
// With normal `npm install`, use apps/web/tsconfig.json, which resolves the real @types/react instead.
declare module 'react' {
  export type ReactNode = any;
  export type Key = string | number;
  export type Dispatch<A> = (value: A) => void;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export interface RefObject<T> { current: T | null }
  export interface MutableRefObject<T> { current: T }
  export interface Context<T> { Provider: (props: { value: T; children?: ReactNode }) => any }
  export interface SyntheticEvent<T = Element> { target: any; currentTarget: T; preventDefault(): void; stopPropagation(): void }
  export interface FormEvent<T = Element> extends SyntheticEvent<T> {}
  export interface ChangeEvent<T = Element> extends SyntheticEvent<T> {}
  export interface MouseEvent<T = Element> extends SyntheticEvent<T> { clientX: number; clientY: number; button: number }
  export interface KeyboardEvent<T = Element> extends SyntheticEvent<T> { key: string }
  export interface WheelEvent<T = Element> extends SyntheticEvent<T> { deltaY: number }
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: any[]) => any>(cb: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export function createContext<T>(defaultValue: T): Context<T>;
  export function useContext<T>(ctx: Context<T>): T;
  export const Fragment: any;
  export const StrictMode: any;
}
declare module 'react/jsx-runtime' { export const jsx: any; export const jsxs: any; export const Fragment: any; }
declare module 'react-dom/client' { export function createRoot(el: Element): { render(node: any): void }; }
declare namespace JSX {
  type Element = any;
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number }
  interface IntrinsicElements { [name: string]: any }
}
