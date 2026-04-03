export interface PresetTable {
  [preset: string]: number;
}

export interface SteeringProfile {
  profile_id: string;
  base_model: string;
  base_model_revision: string;
  layers: number[];
  fallback_layer: number;
  vector_bundle_id: string;
  preset_table: PresetTable;
  judge_bundle: string;
  created_at: string;
}

export interface ReleaseManifest {
  profile_id: string;
  base_model: string;
  base_model_revision: string;
  layers: number[];
  vector_bundle_id: string;
  preset_table: PresetTable;
  created_at: string;
  immutable: true;
}

export interface StructuredError {
  error: {
    code: string;
    message: string;
    status: number;
  };
}
