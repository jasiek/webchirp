// Globals that the browsers this app targets ship but TypeScript's lib.dom
// does not declare, because the specs behind them are not (yet) W3C
// Recommendations that lib.dom tracks. Each block names its source. Only the
// members the app reads are declared; extend a block from its spec when new
// code needs more, rather than reaching for `any`.
//
// Read by tsc only (tsconfig.json includes web/js); nothing loads this file at
// runtime and scripts/build-dist.mjs leaves *.d.ts out of dist/.

export {};

declare global {
  // ---------------------------------------------------------------------------
  // Web Serial API -- WICG draft, https://wicg.github.io/serial/
  // Chromium 89+ on desktop, 138+ on Android (Bluetooth RFCOMM ports there).
  // ---------------------------------------------------------------------------

  interface SerialPortInfo {
    usbVendorId?: number;
    usbProductId?: number;
    bluetoothServiceClassId?: number | string;
  }

  interface SerialOptions {
    baudRate: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: "none" | "even" | "odd";
    bufferSize?: number;
    flowControl?: "none" | "hardware";
  }

  interface SerialOutputSignals {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
    break?: boolean;
  }

  interface SerialInputSignals {
    dataCarrierDetect: boolean;
    clearToSend: boolean;
    ringIndicator: boolean;
    dataSetReady: boolean;
  }

  interface SerialPortFilter {
    usbVendorId?: number;
    usbProductId?: number;
    bluetoothServiceClassId?: number | string;
  }

  interface SerialPortRequestOptions {
    filters?: SerialPortFilter[];
    allowedBluetoothServiceClassIds?: Array<number | string>;
  }

  interface SerialPort extends EventTarget {
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    readonly connected?: boolean;
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
    forget?(): Promise<void>;
    getInfo(): SerialPortInfo;
    setSignals(signals: SerialOutputSignals): Promise<void>;
    getSignals(): Promise<SerialInputSignals>;
  }

  interface Serial extends EventTarget {
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
  }

  // ---------------------------------------------------------------------------
  // WebUSB API -- WICG draft, https://wicg.github.io/webusb/
  // Chromium 61+, including Android, which is why the chip drivers exist.
  // ---------------------------------------------------------------------------

  type USBDirection = "in" | "out";
  type USBEndpointType = "bulk" | "interrupt" | "isochronous";
  type USBTransferStatus = "ok" | "stall" | "babble";
  type USBRequestType = "standard" | "class" | "vendor";
  type USBRecipient = "device" | "interface" | "endpoint" | "other";

  interface USBEndpoint {
    readonly endpointNumber: number;
    readonly direction: USBDirection;
    readonly type: USBEndpointType;
    readonly packetSize: number;
  }

  interface USBAlternateInterface {
    readonly alternateSetting: number;
    readonly interfaceClass: number;
    readonly interfaceSubclass: number;
    readonly interfaceProtocol: number;
    readonly interfaceName?: string | null;
    readonly endpoints: USBEndpoint[];
  }

  interface USBInterface {
    readonly interfaceNumber: number;
    readonly alternate: USBAlternateInterface;
    readonly alternates: USBAlternateInterface[];
    readonly claimed: boolean;
  }

  interface USBConfiguration {
    readonly configurationValue: number;
    readonly configurationName?: string | null;
    readonly interfaces: USBInterface[];
  }

  interface USBControlTransferParameters {
    requestType: USBRequestType;
    recipient: USBRecipient;
    request: number;
    value: number;
    index: number;
  }

  interface USBInTransferResult {
    readonly data?: DataView;
    readonly status?: USBTransferStatus;
  }

  interface USBOutTransferResult {
    readonly bytesWritten: number;
    readonly status?: USBTransferStatus;
  }

  interface USBDevice {
    readonly usbVersionMajor: number;
    readonly usbVersionMinor: number;
    readonly usbVersionSubminor?: number;
    readonly deviceClass: number;
    readonly deviceSubclass?: number;
    readonly deviceProtocol?: number;
    readonly vendorId: number;
    readonly productId: number;
    readonly deviceVersionMajor: number;
    readonly deviceVersionMinor: number;
    readonly deviceVersionSubminor?: number;
    readonly manufacturerName?: string | null;
    readonly productName?: string | null;
    readonly serialNumber?: string | null;
    readonly configuration: USBConfiguration | null;
    readonly configurations?: USBConfiguration[];
    readonly opened: boolean;
    open(): Promise<void>;
    close(): Promise<void>;
    selectConfiguration(configurationValue: number): Promise<void>;
    claimInterface(interfaceNumber: number): Promise<void>;
    releaseInterface(interfaceNumber: number): Promise<void>;
    selectAlternateInterface?(interfaceNumber: number, alternateSetting: number): Promise<void>;
    controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult>;
    controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>;
    clearHalt(direction: USBDirection, endpointNumber: number): Promise<void>;
    transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
    transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
    reset?(): Promise<void>;
  }

  interface USBDeviceFilter {
    vendorId?: number;
    productId?: number;
    classCode?: number;
    subclassCode?: number;
    protocolCode?: number;
    serialNumber?: string;
  }

  interface USBDeviceRequestOptions {
    filters: USBDeviceFilter[];
    exclusionFilters?: USBDeviceFilter[];
  }

  interface USBConnectionEvent extends Event {
    readonly device: USBDevice;
  }

  interface USB extends EventTarget {
    requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
    getDevices(): Promise<USBDevice[]>;
  }

  // ---------------------------------------------------------------------------
  // Web Bluetooth API -- W3C Community Group draft,
  // https://webbluetoothcg.github.io/web-bluetooth/ ; Chromium 56+.
  // ---------------------------------------------------------------------------

  type BluetoothServiceUUID = number | string;
  type BluetoothCharacteristicUUID = number | string;

  interface BluetoothLEScanFilter {
    services?: BluetoothServiceUUID[];
    name?: string;
    namePrefix?: string;
  }

  interface RequestDeviceOptions {
    filters?: BluetoothLEScanFilter[];
    optionalServices?: BluetoothServiceUUID[];
    acceptAllDevices?: boolean;
  }

  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    readonly uuid: string;
    readonly value: DataView | null;
    readValue(): Promise<DataView>;
    writeValue(value: BufferSource): Promise<void>;
    writeValueWithResponse(value: BufferSource): Promise<void>;
    writeValueWithoutResponse(value: BufferSource): Promise<void>;
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  }

  interface BluetoothRemoteGATTService {
    readonly uuid: string;
    getCharacteristic(characteristic: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>;
  }

  interface BluetoothRemoteGATTServer {
    readonly connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>;
  }

  interface BluetoothDevice extends EventTarget {
    readonly id: string;
    readonly name?: string;
    readonly gatt?: BluetoothRemoteGATTServer;
  }

  interface Bluetooth extends EventTarget {
    requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>;
    getAvailability?(): Promise<boolean>;
  }

  // ---------------------------------------------------------------------------
  // User-Agent Client Hints -- WICG, https://wicg.github.io/ua-client-hints/
  // Chromium 90+. Read by the browser-brand detector in web/js/ui/format.js.
  // ---------------------------------------------------------------------------

  interface NavigatorUABrandVersion {
    readonly brand: string;
    readonly version: string;
  }

  interface NavigatorUAData {
    readonly brands: NavigatorUABrandVersion[];
    readonly mobile: boolean;
    readonly platform: string;
  }

  interface Navigator {
    /** Web Serial; absent outside Chromium. */
    readonly serial?: Serial;
    /** WebUSB; absent outside Chromium. */
    readonly usb?: USB;
    /** Web Bluetooth; absent outside Chromium. */
    readonly bluetooth?: Bluetooth;
    /** UA Client Hints; absent outside Chromium. */
    readonly userAgentData?: NavigatorUAData;
    /**
     * Brave's own brand probe, not a standard: Brave reports itself as Chrome
     * everywhere else (https://github.com/brave/brave-browser/issues/10165).
     */
    readonly brave?: { isBrave(): Promise<boolean> };
  }

  // ---------------------------------------------------------------------------
  // Web App Install -- the beforeinstallprompt event, a Chromium extension
  // described in https://wicg.github.io/manifest-incubations/ (not in the
  // Manifest spec proper). Read by web/js/install-prompt.js and
  // web/js/analytics.js.
  // ---------------------------------------------------------------------------

  interface BeforeInstallPromptEvent extends Event {
    readonly platforms?: string[];
    readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
    prompt(): Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
  }

  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
    appinstalled: Event;
  }

  // ---------------------------------------------------------------------------
  // Google tag (gtag.js) -- injected by web/js/analytics.js on the production
  // hosts only; https://developers.google.com/tag-platform/gtagjs/reference
  // ---------------------------------------------------------------------------

  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }

  // ---------------------------------------------------------------------------
  // WebAssembly JavaScript Promise Integration (JSPI) -- W3C WebAssembly CG
  // proposal, https://github.com/WebAssembly/js-promise-integration ; Chrome
  // 137+, Firefox 152+. Pyodide's run_sync needs it; web/app.js feature-tests
  // it. Optional because browsers without JSPI simply lack the members.
  // ---------------------------------------------------------------------------

  namespace WebAssembly {
    const Suspending: (new (fn: (...args: any[]) => Promise<unknown>) => object) | undefined;
    const promising: ((fn: Function) => (...args: any[]) => Promise<unknown>) | undefined;
  }
}
