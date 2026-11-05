import DateTimePicker from '@react-native-community/datetimepicker';
import { Districts, Divisions } from '@dorkar/contracts/places';
import { useMemo, useState, type ReactNode } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { c, fontFor, keyboardAppearance, r, size, themeVariant } from '../design/tokens';
import { useI18n } from '../lib/i18n';
import { Button } from './Button';
import { AlertIcon, CheckIcon, ChevronIcon } from './icons';
import { T } from './Text';

/** A label, one control, a hint and an inline error. Controlled: the page owns state and validation. */
export interface Base {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  optional?: boolean;
}

export function FieldShell({
  label,
  hint,
  error,
  optional,
  children,
}: Base & { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <View style={styles.field}>
      <T v="label" color={c.inkSoft}>
        {label}
        {optional ? ` (${t('common.optional')})` : ''}
      </T>
      {children}
      {hint ? (
        <T v="small" color={c.inkSoft}>
          {hint}
        </T>
      ) : null}
      {error ? (
        <View style={styles.error} accessibilityRole="alert">
          <AlertIcon color={c.redInk} size={18} />
          <T v="small" color={c.redInk} style={styles.shrink}>
            {error}
          </T>
        </View>
      ) : null}
    </View>
  );
}

function useFieldStyle(error?: string) {
  const { lang } = useI18n();
  const [focused, setFocused] = useState(false);
  return {
    focusProps: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
    style: [
      styles.input,
      { fontFamily: fontFor(lang, 500) },
      focused && styles.inputFocus,
      error ? styles.inputError : null,
    ],
  };
}

export function TextField({
  value,
  onChange,
  prefix,
  inputProps,
  placeholder,
  maxLength,
  keyboard,
  multiline,
  testID,
  ...base
}: Base & {
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  placeholder?: string;
  maxLength?: number;
  keyboard?: TextInputProps['keyboardType'];
  multiline?: boolean;
  inputProps?: TextInputProps;
  testID?: string;
}) {
  const { focusProps, style } = useFieldStyle(base.error);
  return (
    <FieldShell {...base}>
      <View style={styles.inputWrap}>
        {prefix ? (
          <T v="bodyStrong" color={c.inkSoft} style={styles.prefix}>
            {prefix}
          </T>
        ) : null}
        <TextInput
          testID={testID}
          accessibilityLabel={base.label}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={c.placeholder}
          maxLength={maxLength}
          keyboardType={keyboard}
          multiline={multiline}
          selectionColor={c.accent}
          keyboardAppearance={keyboardAppearance}
          textAlignVertical={multiline ? 'top' : 'center'}
          style={[style, multiline && styles.multiline, prefix ? { paddingLeft: 44 } : null]}
          {...focusProps}
          {...inputProps}
        />
      </View>
    </FieldShell>
  );
}

export const TextAreaField = (p: Parameters<typeof TextField>[0]) => <TextField {...p} multiline />;

/** A taka amount, typed in either script; parse with parseTaka from @web/lib/money. */
export const MoneyField = (p: Omit<Parameters<typeof TextField>[0], 'prefix' | 'keyboard'>) => (
  <TextField {...p} prefix="৳" keyboard="decimal-pad" />
);

export interface Option {
  value: string;
  label: string;
  group?: string;
}

/** One choice from a list, in a bottom sheet with a filter box when the list is long. */
export function SelectField({
  value,
  onChange,
  options,
  placeholder,
  testID,
  ...base
}: Base & {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  /** First, empty choice ("Any", "Choose…"); omit to force a value. */
  placeholder?: string;
  testID?: string;
}) {
  const { t, lang } = useI18n();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const selected = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const all =
      placeholder !== undefined ? [{ value: '', label: placeholder }, ...options] : options;
    const q = filter.trim().toLowerCase();
    return q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all;
  }, [options, placeholder, filter]);
  return (
    <FieldShell {...base}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`${base.label}: ${selected?.label ?? placeholder ?? ''}`}
        onPress={() => setOpen(true)}
        style={[styles.input, styles.selectRow, base.error ? styles.inputError : null]}
      >
        <T color={selected ? c.ink : c.placeholder} numberOfLines={1} style={styles.shrink}>
          {selected?.label ?? placeholder ?? ''}
        </T>
        <View style={styles.chevDown}>
          <ChevronIcon color={c.inkSoft} size={18} />
        </View>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={styles.overlay}
          accessibilityLabel={t('common.cancel')}
          onPress={() => setOpen(false)}
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
          <T v="section" accessibilityRole="header">
            {base.label}
          </T>
          {options.length > 10 ? (
            <TextInput
              value={filter}
              onChangeText={setFilter}
              placeholder={t('common.filter')}
              keyboardAppearance={keyboardAppearance}
              placeholderTextColor={c.placeholder}
              style={[styles.input, { fontFamily: fontFor(lang, 500) }]}
            />
          ) : null}
          <FlatList
            data={shown}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(o) => o.value || '__empty'}
            renderItem={({ item, index }) => (
              <>
                {item.group && item.group !== shown[index - 1]?.group ? (
                  <T v="label" color={c.inkSoft} style={styles.group}>
                    {item.group}
                  </T>
                ) : null}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: item.value === value }}
                  style={styles.option}
                  onPress={() => {
                    onChange(item.value);
                    setOpen(false);
                    setFilter('');
                  }}
                >
                  <T style={styles.shrink} v={item.value === value ? 'bodyStrong' : 'body'}>
                    {item.label}
                  </T>
                  {item.value === value ? <CheckIcon color={c.accent} size={20} /> : null}
                </Pressable>
              </>
            )}
          />
        </View>
      </Modal>
    </FieldShell>
  );
}

/** A district, grouped by division, named in the page language. */
export function DistrictField(p: Omit<Parameters<typeof SelectField>[0], 'options'>) {
  const { lang } = useI18n();
  const options = useMemo(() => {
    const groups = Object.entries(Divisions as Record<string, { en: string; bn: string }>);
    return groups.flatMap(([id, d]) =>
      Object.entries(
        Districts as unknown as Record<string, { en: string; bn: string; division: string }>,
      )
        .filter(([, x]) => x.division === id)
        .map(([value, x]) => ({ value, label: x[lang], group: d[lang] })),
    );
  }, [lang]);
  return <SelectField {...p} options={options} />;
}

/** A calendar day (YYYY-MM-DD) or a moment (ISO string), through the platform's own picker. */
export function DateField({
  value,
  onChange,
  mode = 'date',
  minimum,
  placeholder,
  ...base
}: Base & {
  value: string;
  onChange: (v: string) => void;
  mode?: 'date' | 'datetime';
  minimum?: Date;
  placeholder?: string;
}) {
  const { t, date } = useI18n();
  const [open, setOpen] = useState<null | 'date' | 'time'>(null);
  const [pending, setPending] = useState<Date | null>(null);
  const insets = useSafeAreaInsets();
  const current = value ? new Date(value) : minimum ?? new Date();
  const commit = (d: Date) => {
    if (mode === 'date') {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      onChange(`${y}-${m}-${day}`);
    } else onChange(d.toISOString());
  };
  const shown = value ? date(value, mode === 'date' ? 'short' : 'long') : placeholder ?? '';
  return (
    <FieldShell {...base}>
      <View style={styles.dateRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${base.label}: ${shown}`}
          onPress={() => {
            setPending(current);
            setOpen('date');
          }}
          style={[
            styles.input,
            styles.selectRow,
            styles.grow,
            base.error ? styles.inputError : null,
          ]}
        >
          <T color={value ? c.ink : c.placeholder}>{shown}</T>
        </Pressable>
        {value && base.optional ? (
          <Button kind="link" small label={t('common.clear')} onPress={() => onChange('')} />
        ) : null}
      </View>
      {Platform.OS === 'android' && open ? (
        <DateTimePicker
          value={pending ?? current}
          mode={open}
          {...(minimum && open === 'date' ? { minimumDate: minimum } : {})}
          onChange={(e, d) => {
            if (e.type !== 'set' || !d) {
              setOpen(null);
              return;
            }
            if (mode === 'datetime' && open === 'date') {
              setPending(d);
              setOpen('time');
            } else {
              setOpen(null);
              commit(d);
            }
          }}
        />
      ) : null}
      {Platform.OS === 'ios' ? (
        <Modal
          visible={!!open}
          transparent
          animationType="slide"
          onRequestClose={() => setOpen(null)}
        >
          <Pressable
            style={styles.overlay}
            accessibilityLabel={t('common.cancel')}
            onPress={() => setOpen(null)}
          />
          <View style={[styles.sheet, styles.dateSheet, { paddingBottom: insets.bottom + 12 }]}>
            <DateTimePicker
              value={pending ?? current}
              mode={mode}
              display={mode === 'date' ? 'inline' : 'spinner'}
              accentColor={c.accent}
              themeVariant={themeVariant}
              {...(minimum ? { minimumDate: minimum } : {})}
              onChange={(_, d) => d && setPending(d)}
            />
            <Button
              block
              label={t('common.save')}
              onPress={() => {
                setOpen(null);
                if (pending) commit(pending);
              }}
            />
          </View>
        </Modal>
      ) : null}
    </FieldShell>
  );
}

export function CheckField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={styles.check}
    >
      <View style={[styles.box, value && styles.boxOn]}>
        {value ? <CheckIcon color={c.onBrand} size={16} /> : null}
      </View>
      <View style={styles.shrink}>
        <T>{label}</T>
        {hint ? (
          <T v="small" color={c.inkSoft}>
            {hint}
          </T>
        ) : null}
      </View>
    </Pressable>
  );
}

export function SwitchField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.switchRow}>
      <T style={styles.shrink}>{label}</T>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: c.brand, false: c.lineStrong }}
        thumbColor={Platform.OS === 'android' ? c.sheet : undefined}
      />
    </View>
  );
}

/** One or many from a short list, as chips that scroll sideways or wrap. */
export function Chips({
  options,
  value,
  onChange,
  label,
}: {
  options: Option[];
  value: string | string[];
  onChange: (v: string) => void;
  label?: string;
}) {
  const on = (v: string) => (Array.isArray(value) ? value.includes(v) : value === v);
  return (
    <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          accessibilityRole={Array.isArray(value) ? 'checkbox' : 'radio'}
          accessibilityState={{ checked: on(o.value) }}
          onPress={() => onChange(o.value)}
          style={[styles.chip, on(o.value) && styles.chipOn]}
        >
          <T v="small" style={styles.chipText} color={on(o.value) ? c.primaryFg : c.ink}>
            {o.label}
          </T>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  shrink: { flexShrink: 1 },
  grow: { flex: 1 },
  error: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  inputWrap: { justifyContent: 'center' },
  prefix: { position: 'absolute', left: 14, zIndex: 1 },
  input: {
    minHeight: size.primary,
    borderRadius: r.control,
    borderWidth: 1.5,
    borderColor: c.lineStrong,
    backgroundColor: c.field,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: c.ink,
    fontSize: 16,
  },
  inputFocus: { borderColor: c.accent, backgroundColor: c.fieldFocus },
  inputError: { borderColor: c.redInk },
  multiline: { minHeight: 112 },
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  chevDown: { transform: [{ rotate: '90deg' }] },
  overlay: { flex: 1, backgroundColor: c.overlay },
  sheet: {
    maxHeight: '75%',
    backgroundColor: c.sheet,
    borderTopLeftRadius: r.card,
    borderTopRightRadius: r.card,
    padding: 16,
    gap: 12,
  },
  dateSheet: { maxHeight: undefined },
  group: { paddingTop: 12, paddingBottom: 4 },
  option: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  check: { flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 44 },
  box: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: c.lineStrong,
    backgroundColor: c.field,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: c.brand, borderColor: c.brand },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 44,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: r.chip,
    borderWidth: 1.5,
    borderColor: c.lineStrong,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: c.primaryBg, borderColor: c.primaryBg },
  chipText: { fontWeight: undefined },
});
