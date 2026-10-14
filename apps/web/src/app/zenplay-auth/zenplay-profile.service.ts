import { Injectable, computed, signal } from '@angular/core';

const PROFILES_STORAGE_KEY = 'zenplay:profiles:v1';
const SELECTED_PROFILE_STORAGE_KEY = 'zenplay:selected-profile:v1';
const MAX_PROFILES = 5;

export interface ZenPlayProfile {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class ZenPlayProfileService {
    private readonly storedProfiles = signal<ZenPlayProfile[]>(
        this.readProfiles()
    );
    private readonly storedSelection = signal<string | null>(
        this.readSelection()
    );

    readonly profiles = this.storedProfiles.asReadonly();
    readonly selectedProfile = computed(() => {
        const selectedId = this.storedSelection();
        return (
            this.storedProfiles().find(
                (profile) => profile.id === selectedId
            ) ?? null
        );
    });
    readonly canAddProfile = computed(
        () => this.storedProfiles().length < MAX_PROFILES
    );

    addAndSelect(name: string): ZenPlayProfile | null {
        const normalizedName = name.trim();
        if (!normalizedName || !this.canAddProfile()) {
            return null;
        }

        const profile: ZenPlayProfile = {
            id: this.createId(),
            name: normalizedName.slice(0, 24),
            createdAt: new Date().toISOString(),
        };
        const profiles = [...this.storedProfiles(), profile];
        this.storedProfiles.set(profiles);
        this.storedSelection.set(profile.id);
        this.write(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
        this.write(SELECTED_PROFILE_STORAGE_KEY, profile.id);
        return profile;
    }

    select(profileId: string): boolean {
        if (
            !this.storedProfiles().some((profile) => profile.id === profileId)
        ) {
            return false;
        }
        this.storedSelection.set(profileId);
        this.write(SELECTED_PROFILE_STORAGE_KEY, profileId);
        return true;
    }

    rename(profileId: string, name: string): ZenPlayProfile | null {
        const normalizedName = name.trim();
        if (!normalizedName) {
            return null;
        }

        const profiles = this.storedProfiles();
        const index = profiles.findIndex((profile) => profile.id === profileId);
        if (index === -1) {
            return null;
        }

        const profile = {
            ...profiles[index],
            name: normalizedName.slice(0, 24),
        };
        const updatedProfiles = [...profiles];
        updatedProfiles[index] = profile;
        this.storedProfiles.set(updatedProfiles);
        this.write(PROFILES_STORAGE_KEY, JSON.stringify(updatedProfiles));
        return profile;
    }

    remove(profileId: string): boolean {
        const profiles = this.storedProfiles();
        if (!profiles.some((profile) => profile.id === profileId)) {
            return false;
        }

        const remainingProfiles = profiles.filter(
            (profile) => profile.id !== profileId
        );
        this.storedProfiles.set(remainingProfiles);
        this.write(PROFILES_STORAGE_KEY, JSON.stringify(remainingProfiles));
        if (this.storedSelection() === profileId) {
            this.storedSelection.set(null);
            this.removeStoredSelection();
        }
        return true;
    }

    requireSelection(): void {
        this.storedSelection.set(null);
        this.removeStoredSelection();
    }

    private readProfiles(): ZenPlayProfile[] {
        try {
            const parsed = JSON.parse(
                localStorage.getItem(PROFILES_STORAGE_KEY) ?? '[]'
            ) as unknown;
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed
                .filter(
                    (profile): profile is ZenPlayProfile =>
                        typeof profile?.id === 'string' &&
                        typeof profile?.name === 'string' &&
                        typeof profile?.createdAt === 'string'
                )
                .slice(0, MAX_PROFILES);
        } catch {
            return [];
        }
    }

    private readSelection(): string | null {
        try {
            return localStorage.getItem(SELECTED_PROFILE_STORAGE_KEY);
        } catch {
            return null;
        }
    }

    private createId(): string {
        if (typeof crypto?.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    private write(key: string, value: string): void {
        try {
            localStorage.setItem(key, value);
        } catch {
            // Safari private mode or a full quota must not break this session.
        }
    }

    private removeStoredSelection(): void {
        try {
            localStorage.removeItem(SELECTED_PROFILE_STORAGE_KEY);
        } catch {
            // Keep the in-memory state usable when storage is unavailable.
        }
    }
}
