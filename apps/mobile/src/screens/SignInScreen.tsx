import { maskBdPhone, normalizeBdPhone } from '@dorkar/contracts';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { c, fontFor, r, keyboardAppearance } from '../design/tokens';
import { useI18n } from '../lib/i18n';
import { nativeAuthApi, type OtpChallenge, type SignedIn } from '../features/auth/api';
import { useSession } from '../features/auth/session';
import { deviceKey, deviceLabel, devicePlatform } from '../lib/device';
import { errorMessage } from '../lib/errors';
import { useNav, useParams } from '../nav/routes';
import { Button } from '../ui/Button';
import { TextField } from '../ui/Fields';
import { Alert, PageTitle, Screen, Stack } from '../ui/Layout';
import { T } from '../ui/Text';

const CODE_LENGTH = 6;

/** Phone → code → signed in. One task per step; the server stays authoritative on every rule. */
export default function SignInScreen() {
  const { t } = useI18n();
  const nav = useNav();
  const params = useParams<'SignIn'>();
  const [challenge, setChallenge] = useState<{ data: OtpChallenge; phone: string } | null>(null);

  const done = (result: SignedIn) => {
    const from = params?.from;
    if (from && !result.isNewAccount)
      nav.dispatch({ type: 'REPLACE', payload: { name: from.name, params: from.params } });
    else if (result.isNewAccount)
      nav.dispatch({ type: 'REPLACE', payload: { name: 'ProfileSettings' } });
    else nav.goBack();
  };

  return (
    <Screen>
      <Stack>
        <PageTitle>{t('signin.title')}</PageTitle>
        <T color={c.inkSoft}>{t('signin.lede')}</T>
      </Stack>
      {challenge ? (
        <CodeStep
          challenge={challenge.data}
          phone={challenge.phone}
          onResent={(data) => setChallenge({ data, phone: challenge.phone })}
          onChangeNumber={() => setChallenge(null)}
          onVerified={done}
        />
      ) : (
        <PhoneStep onSent={(data, phone) => setChallenge({ data, phone })} />
      )}
    </Screen>
  );
}

function PhoneStep({ onSent }: { onSent: (c: OtpChallenge, phone: string) => void }) {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [invalid, setInvalid] = useState(false);
  const send = useMutation({
    mutationFn: (value: string) => nativeAuthApi.requestOtp(value, deviceKey()),
    onSuccess: (data, value) => onSent(data, normalizeBdPhone(value) ?? value),
  });
  const submit = () => {
    if (normalizeBdPhone(phone) === null) return setInvalid(true);
    setInvalid(false);
    send.mutate(phone);
  };
  return (
    <Stack>
      <TextField
        testID="phone"
        label={t('signin.phone')}
        hint={t('signin.phoneHint')}
        value={phone}
        onChange={setPhone}
        placeholder="01XXXXXXXXX"
        keyboard="phone-pad"
        inputProps={{
          autoComplete: 'tel',
          textContentType: 'telephoneNumber',
          onSubmitEditing: submit,
        }}
        {...(invalid ? { error: t('error.INVALID_PHONE') } : {})}
      />
      {send.error ? <Alert message={errorMessage(send.error, t)} /> : null}
      <Button
        testID="send"
        block
        busy={send.isPending}
        label={send.isPending ? t('signin.sending') : t('signin.send')}
        onPress={submit}
      />
      <T v="small" color={c.inkSoft}>
        {t('signin.privacy')}
      </T>
    </Stack>
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
  const { t, lang, num } = useI18n();
  const { establish } = useSession();
  const [code, setCode] = useState('');
  const ref = useRef<React.ComponentRef<typeof TextInput>>(null);
  const [resendAt, setResendAt] = useState(
    () => Date.now() + props.challenge.resendAfterSeconds * 1000,
  );
  const wait = useCountdown(resendAt);

  const verify = useMutation({
    mutationFn: (value: string) =>
      nativeAuthApi.verifyOtp({
        challengeId: props.challenge.challengeId,
        code: value,
        device: { key: deviceKey(), platform: devicePlatform(), label: deviceLabel() },
      }),
    onSuccess: (result) => {
      establish(result);
      props.onVerified(result);
    },
    onError: () => {
      setCode('');
      ref.current?.focus();
    },
  });
  const resend = useMutation({
    mutationFn: () => nativeAuthApi.requestOtp(props.phone, deviceKey()),
    onSuccess: (data) => {
      setResendAt(Date.now() + data.resendAfterSeconds * 1000);
      verify.reset();
      setCode('');
      props.onResent(data);
      ref.current?.focus();
    },
  });
  const onChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH && !verify.isPending) verify.mutate(digits);
  };
  const error = verify.error ?? resend.error;
  return (
    <Stack>
      <T>{t('signin.sentTo', { phone: maskBdPhone(props.phone) })}</T>
      <T v="label" color={c.inkSoft}>
        {t('signin.code')}
      </T>
      <TextInput
        keyboardAppearance={keyboardAppearance}
        ref={ref}
        testID="otp"
        autoFocus
        accessibilityLabel={t('signin.code')}
        value={code}
        onChangeText={onChange}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={CODE_LENGTH}
        selectionColor={c.accent}
        style={[styles.otp, { fontFamily: fontFor(lang, 700) }]}
        placeholder={num(0).repeat(CODE_LENGTH)}
        placeholderTextColor={c.lineStrong}
      />
      {error ? <Alert message={errorMessage(error, t)} /> : null}
      <Button
        block
        busy={verify.isPending}
        disabled={code.length !== CODE_LENGTH}
        label={verify.isPending ? t('signin.verifying') : t('signin.verify')}
        onPress={() => verify.mutate(code)}
      />
      <View style={styles.row}>
        <Button kind="link" small label={t('signin.change')} onPress={props.onChangeNumber} />
        <Button
          kind="link"
          small
          disabled={wait > 0 || resend.isPending}
          label={wait > 0 ? t('signin.resendIn', { s: wait }) : t('signin.resend')}
          onPress={() => resend.mutate()}
        />
      </View>
    </Stack>
  );
}

const styles = StyleSheet.create({
  otp: {
    minHeight: 64,
    borderRadius: r.control,
    borderWidth: 1.5,
    borderColor: c.lineStrong,
    backgroundColor: c.field,
    color: c.ink,
    fontSize: 30,
    letterSpacing: 10,
    textAlign: 'center',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
});
