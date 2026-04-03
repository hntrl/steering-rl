import type { SteeringProfile } from "./types.js";

const profiles = new Map<string, SteeringProfile>();

export function seedProfile(profile: SteeringProfile): void {
  if (profiles.has(profile.profile_id)) {
    throw new Error(
      `Profile ${profile.profile_id} already exists and is immutable`
    );
  }
  profiles.set(profile.profile_id, Object.freeze({ ...profile }));
}

export function getProfile(profileId: string): SteeringProfile | undefined {
  return profiles.get(profileId);
}

export function clearProfiles(): void {
  profiles.clear();
}
