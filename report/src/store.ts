import { create } from "zustand";

export type BucketFilter = "all" | "equivalent" | "couldnt";

type State = {
  section: string;                 // current section anchor
  glossaryOpen: boolean;
  expandedResource: string | null; // scorecard drill-in
  // compare widget
  cmpRt: string;
  cmpSubgroup: string;             // "" = all subgroups for the type
  cmpInstance: string | null;      // tgtId (pairs/cantReproduce) or id (newResources)
  cmpMode: "pairs" | "couldnt" | "extra" | "new"; // which dataset the widget browses
  cmpBucketFilter: BucketFilter;
  cmpDataset: "bridge" | "raw";  // bridge = terminology-bridge ON (canonical); raw = export-only
  showJson: boolean;
  set: (p: Partial<State>) => void;
  openCompare: (rt: string, opts?: Partial<State>) => void;
};

export const useStore = create<State>((set) => ({
  section: "top",
  glossaryOpen: false,
  expandedResource: null,
  cmpRt: "Observation",
  cmpSubgroup: "",
  cmpInstance: null,
  cmpMode: "pairs",
  cmpBucketFilter: "all",
  cmpDataset: "bridge",
  showJson: false,
  set: (p) => set(p),
  openCompare: (rt, opts = {}) =>
    set({ cmpRt: rt, cmpSubgroup: "", cmpInstance: null, cmpMode: "pairs", section: "compare", ...opts }),
}));
