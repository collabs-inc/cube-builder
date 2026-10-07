// Adapted from packages/components/src/CodeEditorView/monaco-react-shim.d.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
declare namespace React {
  type Key = string | number | bigint;
  type ReactElement<P = any, T = any> = any;
  interface ReactPortal extends ReactElement {}
  type ReactNode = any;
  type JSXElementConstructor<P> =
    | ((props: P) => ReactElement | null)
    | (new (props: P) => any);
  type ElementType<
    P = any,
    Tag extends keyof JSX.IntrinsicElements = keyof JSX.IntrinsicElements,
  > = Tag | JSXElementConstructor<P>;

  interface ComponentClass<P = {}> {
    new (props: P): any;
  }

  interface FunctionComponent<P = {}> {
    (props: P): ReactElement | null;
    displayName?: string;
  }

  type ComponentType<P = {}> = ComponentClass<P> | FunctionComponent<P>;
  type FC<P = {}> = FunctionComponent<P>;
  type PropsWithChildren<P = unknown> = P & {
    children?: ReactNode | undefined;
  };

  interface Attributes {
    key?: Key | null | undefined;
  }

  interface RefObject<T> {
    current: T;
  }

  interface MutableRefObject<T> {
    current: T;
  }

  type RefCallback<T> = (instance: T | null) => void;
  type Ref<T> = RefCallback<T> | RefObject<T | null> | null;
  type ForwardedRef<T> = Ref<T>;

  interface RefAttributes<T> extends Attributes {
    ref?: Ref<T> | undefined;
  }

  interface ClassAttributes<T> extends RefAttributes<T> {}

  interface ForwardRefExoticComponent<P> {
    (props: P): ReactElement | null;
    displayName?: string;
  }

  type ComponentProps<T extends ElementType> =
    T extends keyof JSX.IntrinsicElements
      ? JSX.IntrinsicElements[T]
      : T extends JSXElementConstructor<infer P>
        ? P
        : any;

  type ComponentPropsWithRef<T extends ElementType> =
    ComponentProps<T> & RefAttributes<any>;

  type ComponentPropsWithoutRef<T extends ElementType> = ComponentProps<T>;
  type PropsWithoutRef<P> = P;
  type PropsWithRef<P> = P;

  type SetStateAction<S> = S | ((previousState: S) => S);
  type Dispatch<A> = (value: A) => void;
  type DependencyList = readonly unknown[];

  interface CSSProperties {
    [key: string]: string | number | undefined;
  }

  interface AriaAttributes {
    [key: string]: any;
  }

  interface SyntheticEvent<T = Element, E = Event> {
    currentTarget: T;
    target: EventTarget & T;
    nativeEvent: E;
    preventDefault(): void;
    stopPropagation(): void;
    persist(): void;
  }

  type EventHandler<E extends SyntheticEvent<any>> = (event: E) => void;

  interface ClipboardEvent<T = Element> extends SyntheticEvent<T> {}
  interface ChangeEvent<T = Element> extends SyntheticEvent<T> {}
  interface FocusEvent<T = Element> extends SyntheticEvent<T> {}
  interface FormEvent<T = Element> extends SyntheticEvent<T> {}

  interface KeyboardEvent<T = Element> extends SyntheticEvent<T> {
    altKey: boolean;
    ctrlKey: boolean;
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
  }

  interface MouseEvent<T = Element> extends SyntheticEvent<T> {
    altKey: boolean;
    button: number;
    buttons: number;
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }

  interface DragEvent<T = Element> extends MouseEvent<T> {
    dataTransfer: DataTransfer;
  }

  type ClipboardEventHandler<T = Element> = EventHandler<ClipboardEvent<T>>;
  type ChangeEventHandler<T = Element> = EventHandler<ChangeEvent<T>>;
  type FocusEventHandler<T = Element> = EventHandler<FocusEvent<T>>;
  type FormEventHandler<T = Element> = EventHandler<FormEvent<T>>;
  type KeyboardEventHandler<T = Element> = EventHandler<KeyboardEvent<T>>;
  type MouseEventHandler<T = Element> = EventHandler<MouseEvent<T>>;

  interface DOMAttributes<T> {
    children?: ReactNode | undefined;
    dangerouslySetInnerHTML?: { __html: string } | undefined;
    onBlur?: FocusEventHandler<T> | undefined;
    onChange?: ChangeEventHandler<T> | undefined;
    onClick?: MouseEventHandler<T> | undefined;
    onFocus?: FocusEventHandler<T> | undefined;
    onKeyDown?: KeyboardEventHandler<T> | undefined;
    onKeyUp?: KeyboardEventHandler<T> | undefined;
    [key: string]: any;
  }

  interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
    className?: string | undefined;
    id?: string | undefined;
    role?: string | undefined;
    style?: CSSProperties | undefined;
    tabIndex?: number | undefined;
    title?: string | undefined;
    [key: string]: any;
  }

  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    autoComplete?: HTMLInputAutoCompleteAttribute | undefined;
    checked?: boolean | undefined;
    disabled?: boolean | undefined;
    placeholder?: string | undefined;
    type?: string | undefined;
    value?: any;
  }

  interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> {
    disabled?: boolean | undefined;
    type?: string | undefined;
  }

  interface TextareaHTMLAttributes<T> extends HTMLAttributes<T> {
    rows?: number | undefined;
    value?: any;
  }

  interface SVGProps<T> extends HTMLAttributes<T> {}

  type HTMLInputAutoCompleteAttribute = string;
  type DetailedHTMLProps<E, T> = E & ClassAttributes<T>;

  interface DetailedReactHTMLElement<P, T> extends ReactElement<P, T> {}

  interface ProviderProps<T> {
    children?: ReactNode | undefined;
    value: T;
  }

  interface ConsumerProps<T> {
    children: (value: T) => ReactNode;
  }

  interface Provider<T> {
    (props: ProviderProps<T>): ReactElement | null;
  }

  interface Consumer<T> {
    (props: ConsumerProps<T>): ReactElement | null;
  }

  interface Context<T> {
    Consumer: Consumer<T>;
    Provider: Provider<T>;
    displayName?: string | undefined;
  }

  type ContextType<C extends Context<any>> = C extends Context<infer T> ? T : never;

  namespace JSX {
    type ElementType = React.ElementType;
    type Element = any;

    interface ElementClass {}

    interface ElementAttributesProperty {
      props: any;
    }

    interface ElementChildrenAttribute {
      children: any;
    }

    interface IntrinsicAttributes extends Attributes {}

    interface IntrinsicClassAttributes<T> extends ClassAttributes<T> {}

    interface IntrinsicElements {
      [elementName: string]: any;
    }

    type LibraryManagedAttributes<C, P> = P;
  }

  const Children: any;
  const Fragment: any;
  const StrictMode: any;

  function createContext<T>(defaultValue: T): Context<T>;
  function createElement(...args: any[]): any;
  function forwardRef<T, P = {}>(
    render: (props: P, ref: ForwardedRef<T>) => ReactNode,
  ): ForwardRefExoticComponent<P & RefAttributes<T>>;
  function isValidElement(value: unknown): value is ReactElement;
  function memo<T>(component: T): T;
  function startTransition(scope: () => void): void;
  function useContext<T>(context: Context<T>): T;
  function useCallback<T extends (...args: any[]) => any>(
    callback: T,
    deps?: DependencyList,
  ): T;
  function useEffect(
    effect: () => void | (() => void),
    deps?: DependencyList,
  ): void;
  function useImperativeHandle<T>(
    ref: Ref<T> | undefined,
    create: () => T,
    deps?: DependencyList,
  ): void;
  function useLayoutEffect(
    effect: () => void | (() => void),
    deps?: DependencyList,
  ): void;
  function useMemo<T>(
    factory: () => T,
    deps?: DependencyList,
  ): T;
  function useRef<T>(initialValue: T): MutableRefObject<T>;
  function useRef<T>(initialValue: T | null): RefObject<T | null>;
  function useState<S>(
    initialState: S | (() => S),
  ): [S, Dispatch<SetStateAction<S>>];
}

declare module "react" {
  export = React;
  export as namespace React;
}

declare namespace JSX {
  type ElementType = React.JSX.ElementType;
  type Element = React.JSX.Element;

  interface ElementClass extends React.JSX.ElementClass {}

  interface ElementAttributesProperty {
    props: any;
  }

  interface ElementChildrenAttribute {
    children: any;
  }

  interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}

  interface IntrinsicClassAttributes<T>
    extends React.JSX.IntrinsicClassAttributes<T> {}

  interface IntrinsicElements extends React.JSX.IntrinsicElements {}

  type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
}

declare module "react/jsx-runtime" {
  export namespace JSX {
    type ElementType = React.JSX.ElementType;
    type Element = React.JSX.Element;
    interface ElementClass extends React.JSX.ElementClass {}
    interface ElementAttributesProperty
      extends React.JSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute
      extends React.JSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T>
      extends React.JSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
    type LibraryManagedAttributes<C, P> =
      React.JSX.LibraryManagedAttributes<C, P>;
  }

  export const Fragment: any;

  export function jsx(
    type: React.ElementType,
    props: any,
    key?: React.Key,
  ): React.ReactElement;

  export function jsxs(
    type: React.ElementType,
    props: any,
    key?: React.Key,
  ): React.ReactElement;
}

declare module "react/jsx-dev-runtime" {
  export namespace JSX {
    type ElementType = React.JSX.ElementType;
    type Element = React.JSX.Element;
    interface ElementClass extends React.JSX.ElementClass {}
    interface ElementAttributesProperty
      extends React.JSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute
      extends React.JSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T>
      extends React.JSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
    type LibraryManagedAttributes<C, P> =
      React.JSX.LibraryManagedAttributes<C, P>;
  }

  export const Fragment: any;

  export function jsxDEV(
    type: React.ElementType,
    props: any,
    key: React.Key | undefined,
    isStaticChildren: boolean,
    source: unknown,
    self: unknown,
  ): React.ReactElement;
}

declare module "react-dom/client" {
  export function createRoot(container: Element | DocumentFragment): {
    render(children: any): void;
    unmount(): void;
  };
}
