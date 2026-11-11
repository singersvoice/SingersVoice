export interface BackgroundItem {
  id: string;
  kind: 'image' | 'video';
  src: string;
  thumb: string;
  poster?: string;
  width?: number;
  height?: number;
  label: string;
}

export interface BackgroundsIndex {
  schema: 'singersvoice.backgrounds.v1';
  items: BackgroundItem[];
}
