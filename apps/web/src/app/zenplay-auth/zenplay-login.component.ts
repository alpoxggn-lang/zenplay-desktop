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
import {
    ZenPlayLoginFailure,
    ZenPlayLoginService,
} from './zenplay-login.service';

const LOGIN_MESSAGES: Record<ZenPlayLoginFailure, string> = {
    'credentials-required': 'Escribe tu usuario y contraseña.',
    inactive: 'La cuenta no está activa. Verifica tus datos.',
    expired: 'La cuenta está vencida. Renueva tu plan para continuar.',
    unavailable: 'No pudimos conectar con ZenPlay. Inténtalo nuevamente.',
    'content-unavailable': 'No pudimos validar el contenido de esta cuenta.',
    'no-content': 'Esta cuenta no tiene contenido disponible en ZenPlay.',
    'storage-error': 'No se pudo guardar la sesión en este dispositivo.',
};

@Component({
    selector: 'app-zenplay-login',
    imports: [ReactiveFormsModule],
    templateUrl: './zenplay-login.component.html',
    styleUrl: './zenplay-auth.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ZenPlayLoginComponent {
    private readonly loginService = inject(ZenPlayLoginService);
    private readonly router = inject(Router);

    readonly form = new FormGroup({
        username: new FormControl('', {
            nonNullable: true,
            validators: [Validators.required],
        }),
        password: new FormControl('', {
            nonNullable: true,
            validators: [Validators.required],
        }),
    });
    readonly busy = signal(false);
    readonly errorMessage = signal('');
    readonly passwordVisible = signal(false);

    async submit(): Promise<void> {
        if (this.form.invalid || this.busy()) {
            this.form.markAllAsTouched();
            return;
        }

        this.busy.set(true);
        this.errorMessage.set('');
        const result = await this.loginService.login(
            this.form.controls.username.value,
            this.form.controls.password.value
        );
        this.busy.set(false);

        if (!result.ok) {
            this.errorMessage.set(LOGIN_MESSAGES[result.reason]);
            return;
        }
        await this.router.navigateByUrl('/profiles');
    }
}
