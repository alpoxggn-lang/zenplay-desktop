import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ZenPlayProfileService } from './zenplay-profile.service';
import { ZenPlayProfilesComponent } from './zenplay-profiles.component';

describe('ZenPlayProfilesComponent', () => {
    let fixture: ComponentFixture<ZenPlayProfilesComponent>;
    let service: ZenPlayProfileService;

    beforeEach(async () => {
        localStorage.clear();
        await TestBed.configureTestingModule({
            imports: [ZenPlayProfilesComponent],
            providers: [provideRouter([])],
        }).compileComponents();
        service = TestBed.inject(ZenPlayProfileService);
        service.addAndSelect('Principal');
        fixture = TestBed.createComponent(ZenPlayProfilesComponent);
        fixture.detectChanges();
    });

    afterEach(() => TestBed.resetTestingModule());

    it('uses the horizontal ZenPlay wordmark', () => {
        const logo = fixture.nativeElement.querySelector(
            '.zenplay-auth-wordmark'
        ) as HTMLImageElement | null;

        expect(logo?.getAttribute('src')).toBe(
            'assets/branding/zenplay-wordmark-horizontal.png'
        );
    });

    it('edits a profile name from its profile card', () => {
        const editButton = fixture.nativeElement.querySelector(
            '[aria-label="Editar Principal"]'
        ) as HTMLButtonElement;
        editButton.click();
        fixture.detectChanges();

        const input = fixture.nativeElement.querySelector(
            '[data-test-id="zenplay-profile-edit-input"]'
        ) as HTMLInputElement;
        input.value = 'Familia';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        (fixture.nativeElement.querySelector(
            '.zenplay-profile-editor button[type="submit"]'
        ) as HTMLButtonElement).click();
        fixture.detectChanges();

        expect(service.profiles()[0]?.name).toBe('Familia');
        expect(
            fixture.nativeElement.querySelector(
                '[data-test-id="zenplay-profile-edit-input"]'
            )
        ).toBeNull();
    });

    it('requires confirmation before deleting a profile', () => {
        const deleteButton = fixture.nativeElement.querySelector(
            '[aria-label="Eliminar Principal"]'
        ) as HTMLButtonElement;
        deleteButton.click();
        fixture.detectChanges();

        expect(service.profiles()).toHaveLength(1);
        (fixture.nativeElement.querySelector(
            '.zenplay-profile-delete-confirmation .zenplay-profile-delete'
        ) as HTMLButtonElement).click();
        fixture.detectChanges();

        expect(service.profiles()).toEqual([]);
        expect(service.selectedProfile()).toBeNull();
    });
});
