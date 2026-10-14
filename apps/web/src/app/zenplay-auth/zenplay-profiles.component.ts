import {
    ChangeDetectionStrategy,
    Component,
    inject,
    signal,
} from '@angular/core';
import {
    FormControl,
    FormGroup,
    ReactiveFormsModule,
    Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { ZENPLAY_CATALOG_PATH } from './zenplay.constants';
import {
    type ZenPlayProfile,
    ZenPlayProfileService,
} from './zenplay-profile.service';

@Component({
    selector: 'app-zenplay-profiles',
    imports: [ReactiveFormsModule],
    templateUrl: './zenplay-profiles.component.html',
    styleUrl: './zenplay-auth.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ZenPlayProfilesComponent {
    readonly profileService = inject(ZenPlayProfileService);
    private readonly router = inject(Router);

    readonly form = new FormGroup({
        name: new FormControl('', {
            nonNullable: true,
            validators: [Validators.required, Validators.maxLength(24)],
        }),
    });
    readonly editForm = new FormGroup({
        name: new FormControl('', {
            nonNullable: true,
            validators: [Validators.required, Validators.maxLength(24)],
        }),
    });
    readonly editingProfileId = signal<string | null>(null);
    readonly deleteConfirmationId = signal<string | null>(null);

    async createProfile(): Promise<void> {
        if (this.form.invalid) {
            this.form.markAllAsTouched();
            return;
        }
        const profile = this.profileService.addAndSelect(
            this.form.controls.name.value
        );
        if (profile) {
            await this.router.navigateByUrl(ZENPLAY_CATALOG_PATH);
        }
    }

    async chooseProfile(profileId: string): Promise<void> {
        if (this.profileService.select(profileId)) {
            await this.router.navigateByUrl(ZENPLAY_CATALOG_PATH);
        }
    }

    beginEdit(profile: ZenPlayProfile): void {
        this.deleteConfirmationId.set(null);
        this.editingProfileId.set(profile.id);
        this.editForm.setValue({ name: profile.name });
    }

    cancelEdit(): void {
        this.editingProfileId.set(null);
        this.editForm.reset({ name: '' });
    }

    saveProfile(profileId: string): void {
        if (this.editForm.invalid) {
            this.editForm.markAllAsTouched();
            return;
        }
        if (
            this.profileService.rename(
                profileId,
                this.editForm.controls.name.value
            )
        ) {
            this.cancelEdit();
        }
    }

    requestDelete(profileId: string): void {
        this.cancelEdit();
        this.deleteConfirmationId.set(profileId);
    }

    cancelDelete(): void {
        this.deleteConfirmationId.set(null);
    }

    deleteProfile(profileId: string): void {
        if (this.profileService.remove(profileId)) {
            this.cancelDelete();
        }
    }

    initial(name: string): string {
        return name.trim().charAt(0).toUpperCase() || 'Z';
    }
}
