export interface SteeringProfile {
  profile_id: string;
  base_model: string;
  base_model_revision: string;
  layers: number[];
  fallback_layer: number;
  vector_bundle_id: string;
  preset_table: Record<string, number>;
  judge_bundle: string;
  created_at: string;
}

const DEFAULT_PROFILES: SteeringProfile[] = [
  {
    profile_id: "steer-gemma3-default-v12",
    base_model: "gemma-3-27b-it",
    base_model_revision: "2026-03-15",
    layers: [23, 29, 35, 41, 47],
    fallback_layer: 41,
    vector_bundle_id: "vec-bundle-2026-04-01-rc2",
    preset_table: {
      low: 0.12,
      medium: 0.22,
      strong: 0.34,
    },
    judge_bundle: "judge-v4",
    created_at: "2026-04-02T00:00:00Z",
  },
];

export class ProfileRegistry {
  private profiles: Map<string, SteeringProfile>;

  constructor(initialProfiles?: SteeringProfile[]) {
    this.profiles = new Map();
    for (const profile of initialProfiles ?? DEFAULT_PROFILES) {
      this.profiles.set(profile.profile_id, profile);
    }
  }

  resolve(profileId: string): SteeringProfile | null {
    return this.profiles.get(profileId) ?? null;
  }

  register(profile: SteeringProfile): void {
    if (this.profiles.has(profile.profile_id)) {
      throw new Error(`Profile ${profile.profile_id} already exists (immutable)`);
    }
    this.profiles.set(profile.profile_id, profile);
  }

  list(): SteeringProfile[] {
    return Array.from(this.profiles.values());
  }
}

export const defaultRegistry = new ProfileRegistry();
