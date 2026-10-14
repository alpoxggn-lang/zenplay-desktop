import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
    FormControl,
    FormGroup,
    ReactiveFormsModule,
    Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { ZENPLAY_CATALOG_PATH } from './zenplay.constants';
import { ZenPlayProfileService } from './zenplay-profile.service';

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

    initial(name: string): string {
        return name.trim().charAt(0).toUpperCase() || 'Z';
    }
}
