import { zodResolver } from '@hookform/resolvers/zod';
import { maskBdPhone, normalizeBdPhone } from '@dorkar/contracts';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AlertIcon } from '../../components/glyphs/glyphs';
import { Biro } from '../../components/ui/Biro';
import { deviceKey, deviceLabel } from '../../lib/device';
import { errorMessage } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { authApi, type OtpChallenge, type SignedIn } from './api';
import { useSession } from './session';

const phoneSchema = z.object({
  phone: z.string().refine((v) => normalizeBdPhone(v) !== null, { message: 'INVALID_PHONE' }),
});
type PhoneForm = z.infer<typeof phoneSchema>;

const CODE_LENGTH = 6;

/** Phone → code → signed in. One task per step; the server stays authoritative on every rule. */
export function SignInFlow({ onDone }: { onDone: (result: SignedIn) => void }) {
  const [challenge, setChallenge] = useState<{ data: OtpChallenge; phone: string } | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  if (signedIn) return <Done />;
  if (!challenge) {
    return <PhoneStep onSent={(data, phone) => setChallenge({ data, phone })} />;
  }
  return (
    <CodeStep
      challenge={challenge.data}
      phone={challenge.phone}
      onResent={(data) => setChallenge({ data, phone: challenge.phone })}
      onChangeNumber={() => setChallenge(null)}
      onVerified={(r) => {
        setSignedIn(true);
        onDone(r);
      }}
    />
  );
}

function PhoneStep({ onSent }: { onSent: (c: OtpChallenge, phone: string) => void }) {
  const { t } = useI18n();
  const hintId = useId();
  const errId = useId();
  const form = useForm<PhoneForm>({
    resolver: zodResolver(phoneSchema),
    defaultValues: { phone: '' },
  });
  const send = useMutation({
    mutationFn: (phone: string) => authApi.requestOtp(phone, deviceKey()),
    onSuccess: (data, phone) => onSent(data, normalizeBdPhone(phone) ?? phone),
  });

  const fieldError = form.formState.errors.phone ? t('error.INVALID_PHONE') : null;
  const error = fieldError ?? (send.error ? errorMessage(send.error, t) : null);

  return (
    <form onSubmit={(e) => void form.handleSubmit((v) => send.mutate(v.phone))(e)} noValidate>
      <div className="field" data-invalid={error ? '' : undefined}>
        <label className="label" htmlFor="phone">
          {t('signin.phone')}
        </label>
        <div className="field__control">
          <span className="field__prefix code" aria-hidden="true">
            +88
          </span>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="01XXXXXXXXX"
            aria-invalid={!!error}
            aria-describedby={`${hintId}${error ? ` ${errId}` : ''}`}
            {...form.register('phone')}
          />
        </div>
        <p className="field__hint" id={hintId}>
          {t('signin.phoneHint')}
        </p>
      </div>
      {error && (
        <p className="alert" role="alert" id={errId}>
          <AlertIcon />
          <span>{error}</span>
        </p>
      )}
      <button type="submit" className="btn btn--block" disabled={send.isPending}>
        {send.isPending ? t('signin.sending') : t('signin.send')}
      </button>
      <p className="field__hint">{t('signin.privacy')}</p>
    </form>
  );
}

function useCountdown(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= until) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [until, now]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

function CodeStep(props: {
  challenge: OtpChallenge;
  phone: string;
  onResent: (c: OtpChallenge) => void;
  onChangeNumber: () => void;
  onVerified: (r: SignedIn) => void;
}) {
  const { t } = useI18n();
  const { establish } = useSession();
  const [code, setCode] = useState('');
  const [focused, setFocused] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const errId = useId();
  const [resendAt, setResendAt] = useState(
    () => Date.now() + props.challenge.resendAfterSeconds * 1000,
  );
  const wait = useCountdown(resendAt);

  const verify = useMutation({
    mutationFn: (value: string) =>
      authApi.verifyOtp({
        challengeId: props.challenge.challengeId,
        code: value,
        device: { key: deviceKey(), platform: 'web', label: deviceLabel() },
      }),
    onSuccess: (r) => {
      establish(r);
      props.onVerified(r);
    },
    onError: () => {
      setCode('');
      inputRef.current?.focus();
    },
  });

  const resend = useMutation({
    mutationFn: () => authApi.requestOtp(props.phone, deviceKey()),
    onSuccess: (data) => {
      setResendAt(Date.now() + data.resendAfterSeconds * 1000);
      verify.reset();
      setCode('');
      props.onResent(data);
      inputRef.current?.focus();
    },
  });

  // Android Chrome can read the code straight from the SMS (WebOTP), with the user's consent.
  useEffect(() => {
    if (!('OTPCredential' in window)) return;
    const ac = new AbortController();
    navigator.credentials
      .get({ otp: { transport: ['sms'] }, signal: ac.signal } as CredentialRequestOptions)
      .then((cred) => {
        const value = (cred as unknown as { code?: string } | null)?.code;
        if (value && /^\d{6}$/.test(value)) {
          setCode(value);
          verify.mutate(value);
        }
      })
      .catch(() => {});
    return () => ac.abort();
    // Re-arm once per challenge only.
  }, [props.challenge.challengeId]);

  const onChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH && !verify.isPending) verify.mutate(digits);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === CODE_LENGTH) verify.mutate(code);
  };

  const error = verify.error ?? resend.error;
  const message = error ? errorMessage(error, t) : null;

  return (
    <form onSubmit={submit} noValidate>
      <p>{t('signin.sentTo', { phone: maskBdPhone(props.phone) })}</p>
      <div className="field">
        <label className="label" htmlFor="otp">
          {t('signin.code')}
        </label>
        <div className="otp" data-invalid={message ? '' : undefined}>
          <input
            id="otp"
            ref={inputRef}
            className="otp__input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={CODE_LENGTH}
            value={code}
            autoFocus
            aria-invalid={!!message}
            aria-describedby={message ? errId : undefined}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => onChange(e.target.value)}
          />
          <div className="otp__boxes" aria-hidden="true">
            {Array.from({ length: CODE_LENGTH }, (_, i) => (
              <span
                key={i}
                className="otp__box"
                data-active={
                  focused && i === Math.min(code.length, CODE_LENGTH - 1) ? '' : undefined
                }
              >
                {code[i] ?? ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      {message && (
        <p className="alert" role="alert" id={errId}>
          <AlertIcon />
          <span>{message}</span>
        </p>
      )}
      <button
        type="submit"
        className="btn btn--block"
        disabled={verify.isPending || code.length !== CODE_LENGTH}
      >
        {verify.isPending ? t('signin.verifying') : t('signin.verify')}
      </button>
      <div className="signin__meta">
        <button type="button" className="linkbtn" onClick={props.onChangeNumber}>
          {t('signin.change')}
        </button>
        <button
          type="button"
          className="linkbtn"
          disabled={wait > 0 || resend.isPending}
          onClick={() => resend.mutate()}
        >
          {wait > 0 ? t('signin.resendIn', { s: wait }) : t('signin.resend')}
        </button>
      </div>
    </form>
  );
}

function Done() {
  const { t } = useI18n();
  return (
    <div className="signin__done" role="status">
      <h2>{t('signin.done')}</h2>
      <Biro draw tilt={-4} />
    </div>
  );
}
