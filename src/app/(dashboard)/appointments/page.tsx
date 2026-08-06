"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Appointment, AppointmentStatus, Contact, Service } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_REMINDER_TEMPLATE } from "@/lib/appointments/reminder-template";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";

// ------------------------------------------------------------
// Weekly calendar for the appointments module (migration 038).
//
// Data access is the browser Supabase client under RLS, the same
// pattern as /pipelines — no internal API layer needed. The public
// API (/api/v1/appointments) is the machine door for bots; this page
// is the human one.
// ------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** Visible day window: 8:00–20:00 local, 48px per hour. */
const FIRST_HOUR = 8;
const LAST_HOUR = 20;
const HOUR_PX = 48;

const STATUS_STYLES: Record<AppointmentStatus, string> = {
  confirmed:
    "border-l-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20",
  pending: "border-l-amber-500 bg-amber-500/10 hover:bg-amber-500/20",
  cancelled:
    "border-l-rose-500 bg-rose-500/10 opacity-60 hover:bg-rose-500/20",
  completed: "border-l-border bg-muted/60 opacity-80 hover:bg-muted",
  no_show: "border-l-rose-500 bg-rose-500/10 hover:bg-rose-500/20",
};

const STATUS_DOT: Record<AppointmentStatus, string> = {
  confirmed: "bg-emerald-500",
  pending: "bg-amber-500",
  cancelled: "bg-rose-500",
  completed: "bg-muted-foreground",
  no_show: "bg-rose-500",
};

/** Monday 00:00 (local) of the week containing `d`. */
function weekStart(d: Date): Date {
  const monday = new Date(d);
  monday.setHours(0, 0, 0, 0);
  const day = monday.getDay(); // 0 = Sunday
  monday.setDate(monday.getDate() - ((day + 6) % 7));
  return monday;
}

function toLocalDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default function AppointmentsPage() {
  const t = useTranslations("Appointments");
  const locale = useLocale();
  const supabase = createClient();
  const { accountId, user } = useAuth();
  const canWrite = useCan("send-messages");
  const canManageServices = useCan("edit-settings");

  const [anchor, setAnchor] = useState(() => weekStart(new Date()));
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  // New-appointment dialog
  const [newOpen, setNewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<Contact[]>([]);
  const [pickedContact, setPickedContact] = useState<Contact | null>(null);
  const [serviceId, setServiceId] = useState<string>("none");
  const [dateInput, setDateInput] = useState(() => toLocalDateInput(new Date()));
  const [timeInput, setTimeInput] = useState("10:00");
  const [durationInput, setDurationInput] = useState(30);
  const [notesInput, setNotesInput] = useState("");

  // Detail dialog
  const [detail, setDetail] = useState<Appointment | null>(null);
  const [updating, setUpdating] = useState(false);

  // Services dialog
  const [servicesOpen, setServicesOpen] = useState(false);
  const [svcName, setSvcName] = useState("");
  const [svcDuration, setSvcDuration] = useState(30);
  const [svcPrice, setSvcPrice] = useState("");

  // Business timezone (accounts.timezone, migration 039) — drives the
  // AI booking assistant's local-time math. Empty string = unset (UTC).
  const [accountTz, setAccountTz] = useState("");
  // Reminder knobs (accounts.*, migration 040). The template textarea
  // saves on blur; empty = use the built-in default.
  const [remindersEnabled, setRemindersEnabled] = useState(true);
  const [reminderTemplate, setReminderTemplate] = useState("");
  const [savedReminderTemplate, setSavedReminderTemplate] = useState("");
  const timeZones = useMemo<string[]>(
    () =>
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : [],
    [],
  );

  const days = useMemo(
    () => Array.from({ length: 6 }, (_, i) => new Date(anchor.getTime() + i * DAY_MS)),
    [anchor],
  );

  const loadWeek = useCallback(async () => {
    const from = anchor.toISOString();
    const to = new Date(anchor.getTime() + 7 * DAY_MS).toISOString();
    const { data, error } = await supabase
      .from("appointments")
      .select("*, contact:contacts(id, name, phone)")
      .gte("starts_at", from)
      .lt("starts_at", to)
      .order("starts_at");
    if (error) {
      console.error("Failed to load appointments:", error.message);
      return;
    }
    setAppointments((data ?? []) as Appointment[]);
  }, [supabase, anchor]);

  const loadServices = useCallback(async () => {
    const { data } = await supabase
      .from("services")
      .select("*")
      .order("created_at");
    setServices((data ?? []) as Service[]);
  }, [supabase]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("accounts")
        .select(
          "timezone, appointment_reminders_enabled, appointment_reminder_template",
        )
        .eq("id", accountId)
        .maybeSingle();
      if (cancelled || !data) return;
      setAccountTz((data.timezone as string | null) ?? "");
      setRemindersEnabled(data.appointment_reminders_enabled !== false);
      const tpl = (data.appointment_reminder_template as string | null) ?? "";
      setReminderTemplate(tpl);
      setSavedReminderTemplate(tpl);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, accountId]);

  async function saveRemindersEnabled(enabled: boolean) {
    if (!accountId) return;
    const prev = remindersEnabled;
    setRemindersEnabled(enabled);
    const { error } = await supabase
      .from("accounts")
      .update({ appointment_reminders_enabled: enabled })
      .eq("id", accountId);
    if (error) {
      setRemindersEnabled(prev);
      toast.error(t("toasts.reminderFailed"));
      return;
    }
    toast.success(t("toasts.reminderSaved"));
  }

  async function saveReminderTemplate() {
    if (!accountId || reminderTemplate === savedReminderTemplate) return;
    const value = reminderTemplate.trim();
    const { error } = await supabase
      .from("accounts")
      .update({ appointment_reminder_template: value || null })
      .eq("id", accountId);
    if (error) {
      toast.error(t("toasts.reminderFailed"));
      return;
    }
    setSavedReminderTemplate(reminderTemplate);
    toast.success(t("toasts.reminderSaved"));
  }

  async function saveTimezone(tz: string) {
    if (!accountId) return;
    const prev = accountTz;
    setAccountTz(tz);
    const { error } = await supabase
      .from("accounts")
      .update({ timezone: tz || null })
      .eq("id", accountId);
    if (error) {
      setAccountTz(prev);
      toast.error(t("toasts.timezoneFailed"));
      return;
    }
    toast.success(t("toasts.timezoneSaved"));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadWeek(), loadServices()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadWeek, loadServices]);

  // Contact search inside the new-appointment dialog. All setState
  // goes through the debounce timeout (never synchronously in the
  // effect body) so typing can't trigger cascading renders.
  useEffect(() => {
    const handle = setTimeout(async () => {
      if (!newOpen || contactQuery.trim().length < 2) {
        setContactResults([]);
        return;
      }
      const q = contactQuery.trim().replace(/[,()]/g, "");
      const { data } = await supabase
        .from("contacts")
        .select("id, name, phone, account_id, user_id, created_at, updated_at")
        .or(`name.ilike.*${q}*,phone.ilike.*${q}*`)
        .limit(8);
      setContactResults((data ?? []) as Contact[]);
    }, 250);
    return () => clearTimeout(handle);
  }, [contactQuery, newOpen, supabase]);

  function openNewDialog(day?: Date, hour?: number) {
    setPickedContact(null);
    setContactQuery("");
    setServiceId("none");
    setDateInput(toLocalDateInput(day ?? new Date()));
    setTimeInput(hour !== undefined ? `${String(hour).padStart(2, "0")}:00` : "10:00");
    setDurationInput(30);
    setNotesInput("");
    setNewOpen(true);
  }

  async function createAppointment() {
    if (!accountId || !pickedContact) return;
    const starts = new Date(`${dateInput}T${timeInput}:00`);
    if (Number.isNaN(starts.getTime())) {
      toast.error(t("toasts.invalidDate"));
      return;
    }
    const ends = new Date(starts.getTime() + durationInput * 60_000);
    const service = services.find((s) => s.id === serviceId);

    setSaving(true);
    // Client-side overlap check — the calendar equivalent of the API's
    // hasOverlap guard. RLS scopes the query to this account.
    const { count } = await supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .neq("status", "cancelled")
      .lt("starts_at", ends.toISOString())
      .gt("ends_at", starts.toISOString());
    if ((count ?? 0) > 0) {
      setSaving(false);
      toast.error(t("toasts.slotTaken"));
      return;
    }

    const { error } = await supabase.from("appointments").insert({
      account_id: accountId,
      contact_id: pickedContact.id,
      service_id: service?.id ?? null,
      service_name: service?.name ?? null,
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
      status: "confirmed",
      notes: notesInput || null,
      created_by: user?.id ?? null,
    });
    setSaving(false);
    if (error) {
      toast.error(t("toasts.createFailed"));
      console.error("Failed to create appointment:", error.message);
      return;
    }
    toast.success(t("toasts.created"));
    setNewOpen(false);
    loadWeek();
  }

  async function setStatus(apt: Appointment, status: AppointmentStatus) {
    setUpdating(true);
    const { error } = await supabase
      .from("appointments")
      .update({ status })
      .eq("id", apt.id);
    setUpdating(false);
    if (error) {
      toast.error(t("toasts.updateFailed"));
      return;
    }
    toast.success(t("toasts.updated"));
    setDetail(null);
    loadWeek();
  }

  async function deleteAppointment(apt: Appointment) {
    setUpdating(true);
    const { error } = await supabase
      .from("appointments")
      .delete()
      .eq("id", apt.id);
    setUpdating(false);
    if (error) {
      toast.error(t("toasts.deleteFailed"));
      return;
    }
    toast.success(t("toasts.deleted"));
    setDetail(null);
    loadWeek();
  }

  async function addService() {
    if (!accountId || !svcName.trim()) return;
    const { error } = await supabase.from("services").insert({
      account_id: accountId,
      name: svcName.trim(),
      duration_minutes: svcDuration,
      price: svcPrice ? Number(svcPrice) : null,
    });
    if (error) {
      toast.error(t("toasts.serviceFailed"));
      return;
    }
    setSvcName("");
    setSvcPrice("");
    loadServices();
  }

  async function removeService(id: string) {
    const { error } = await supabase.from("services").delete().eq("id", id);
    if (error) {
      toast.error(t("toasts.serviceFailed"));
      return;
    }
    loadServices();
  }

  const dayFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric" }),
    [locale],
  );
  const rangeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }),
    [locale],
  );
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }),
    [locale],
  );
  // Gutter labels: hour-only, so the locale decides 12h ("8 AM") vs 24h.
  const hourFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "numeric" }),
    [locale],
  );

  const today = toLocalDateInput(new Date());
  const hours = Array.from(
    { length: LAST_HOUR - FIRST_HOUR },
    (_, i) => FIRST_HOUR + i,
  );

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarDays className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <div className="ml-2 flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setAnchor(new Date(anchor.getTime() - 7 * DAY_MS))}
            aria-label={t("prevWeek")}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setAnchor(weekStart(new Date()))}
          >
            {t("today")}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setAnchor(new Date(anchor.getTime() + 7 * DAY_MS))}
            aria-label={t("nextWeek")}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <span className="text-sm text-muted-foreground">
          {rangeFmt.format(anchor)} – {rangeFmt.format(new Date(anchor.getTime() + 5 * DAY_MS))}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {canManageServices && (
            <Button variant="outline" size="sm" onClick={() => setServicesOpen(true)}>
              <Settings2 className="mr-1.5 h-4 w-4" />
              {t("services")}
            </Button>
          )}
          {canWrite && (
            <Button size="sm" onClick={() => openNewDialog()}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t("newAppointment")}
            </Button>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {(["confirmed", "pending", "cancelled"] as AppointmentStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cn("h-2 w-2 rounded-full", STATUS_DOT[s])} />
            {t(`status.${s}`)}
          </span>
        ))}
      </div>

      {/* Week grid */}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <div className="min-w-[760px]">
          {/* Day headers */}
          <div className="grid grid-cols-[56px_repeat(6,1fr)] border-b border-border text-center text-xs">
            <div />
            {days.map((d) => {
              const isToday = toLocalDateInput(d) === today;
              return (
                <div
                  key={d.toISOString()}
                  className={cn(
                    "py-2 font-medium capitalize",
                    isToday ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {dayFmt.format(d)}
                  {isToday && (
                    <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                      {t("todayBadge")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {/* Body */}
          <div className="grid grid-cols-[56px_repeat(6,1fr)]">
            {/* Hour gutter */}
            <div className="relative" style={{ height: hours.length * HOUR_PX }}>
              {hours.map((h, i) => (
                <span
                  key={h}
                  className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
                  style={{ top: i * HOUR_PX }}
                >
                  {hourFmt.format(new Date(2000, 0, 1, h))}
                </span>
              ))}
            </div>
            {days.map((day) => {
              const dayStr = toLocalDateInput(day);
              const dayApts = appointments.filter(
                (a) => toLocalDateInput(new Date(a.starts_at)) === dayStr,
              );
              return (
                <div
                  key={day.toISOString()}
                  className="relative border-l border-border"
                  style={{
                    height: hours.length * HOUR_PX,
                    backgroundImage:
                      "repeating-linear-gradient(to bottom, transparent 0, transparent 47px, var(--border) 47px, var(--border) 48px)",
                  }}
                >
                  {/* Click-to-create on empty hours */}
                  {canWrite &&
                    hours.map((h, i) => (
                      <button
                        key={h}
                        type="button"
                        aria-label={`${t("newAppointment")} ${dayStr} ${h}:00`}
                        className="absolute left-0 right-0 focus-visible:ring-2 focus-visible:ring-primary"
                        style={{ top: i * HOUR_PX, height: HOUR_PX }}
                        onClick={() => openNewDialog(day, h)}
                      />
                    ))}
                  {dayApts.map((apt) => {
                    const start = new Date(apt.starts_at);
                    const end = new Date(apt.ends_at);
                    const startMin =
                      start.getHours() * 60 + start.getMinutes() - FIRST_HOUR * 60;
                    const durMin = Math.max(
                      (end.getTime() - start.getTime()) / 60_000,
                      30,
                    );
                    if (startMin + durMin < 0 || startMin > hours.length * 60)
                      return null;
                    const heightPx = Math.max((durMin / 60) * HOUR_PX - 2, 22);
                    // Two 11px lines need ~34px; below that, collapse to
                    // one line so nothing renders half-clipped.
                    const compact = heightPx < 34;
                    return (
                      <button
                        key={apt.id}
                        type="button"
                        onClick={() => setDetail(apt)}
                        className={cn(
                          "absolute left-0.5 right-0.5 overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-[11px] leading-tight transition-colors focus-visible:ring-2 focus-visible:ring-primary",
                          STATUS_STYLES[apt.status],
                        )}
                        style={{
                          top: Math.max((startMin / 60) * HOUR_PX, 0),
                          height: heightPx,
                        }}
                      >
                        {compact ? (
                          <span className="block truncate">
                            <span className="font-medium">
                              {timeFmt.format(start)}
                            </span>{" "}
                            · {apt.contact?.name || apt.contact?.phone || "—"}
                            {apt.service_name && ` · ${apt.service_name}`}
                          </span>
                        ) : (
                          <>
                            <span className="block truncate font-medium">
                              {apt.service_name || t("noService")}
                            </span>
                            <span className="block truncate text-muted-foreground">
                              {timeFmt.format(start)} ·{" "}
                              {apt.contact?.name || apt.contact?.phone || "—"}
                            </span>
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ---------- New appointment dialog ---------- */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("newAppointment")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {/* Contact picker */}
            <div className="flex flex-col gap-1.5">
              <Label>{t("contact")}</Label>
              {pickedContact ? (
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                  <span>
                    {pickedContact.name || pickedContact.phone}
                    <span className="ml-2 text-muted-foreground">
                      {pickedContact.phone}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPickedContact(null)}
                  >
                    {t("change")}
                  </Button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder={t("searchContact")}
                    value={contactQuery}
                    onChange={(e) => setContactQuery(e.target.value)}
                  />
                  {contactResults.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
                      {contactResults.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
                          onClick={() => {
                            setPickedContact(c);
                            setContactResults([]);
                          }}
                        >
                          <span>{c.name || c.phone}</span>
                          <span className="text-xs text-muted-foreground">
                            {c.phone}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Service */}
            <div className="flex flex-col gap-1.5">
              <Label>{t("service")}</Label>
              <Select
                value={serviceId}
                onValueChange={(v) => {
                  setServiceId(v ?? "none");
                  const svc = services.find((s) => s.id === v);
                  if (svc) setDurationInput(svc.duration_minutes);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("noService")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("noService")}</SelectItem>
                  {services
                    .filter((s) => s.is_active)
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} · {s.duration_minutes} min
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {/* Date / time / duration */}
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apt-date">{t("date")}</Label>
                <Input
                  id="apt-date"
                  type="date"
                  value={dateInput}
                  onChange={(e) => setDateInput(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apt-time">{t("time")}</Label>
                <Input
                  id="apt-time"
                  type="time"
                  value={timeInput}
                  onChange={(e) => setTimeInput(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apt-duration">{t("duration")}</Label>
                <Input
                  id="apt-duration"
                  type="number"
                  min={5}
                  max={1440}
                  step={5}
                  value={durationInput}
                  onChange={(e) => setDurationInput(Number(e.target.value) || 30)}
                />
              </div>
            </div>

            {/* Notes */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="apt-notes">{t("notes")}</Label>
              <Textarea
                id="apt-notes"
                rows={2}
                value={notesInput}
                onChange={(e) => setNotesInput(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={createAppointment}
              disabled={!pickedContact || saving}
            >
              {saving ? t("saving") : t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- Detail dialog ---------- */}
      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="sm:max-w-md">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span
                    className={cn("h-2.5 w-2.5 rounded-full", STATUS_DOT[detail.status])}
                  />
                  {detail.service_name || t("noService")}
                </DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("contact")}</span>
                  <span>
                    {detail.contact?.name || "—"}
                    {detail.contact?.phone && (
                      <span className="ml-2 text-muted-foreground">
                        {detail.contact.phone}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("date")}</span>
                  <span>
                    {new Intl.DateTimeFormat(locale, {
                      weekday: "long",
                      day: "numeric",
                      month: "short",
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(detail.starts_at))}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("statusLabel")}</span>
                  <span>{t(`status.${detail.status}`)}</span>
                </div>
                {detail.notes && (
                  <div className="rounded-md bg-muted/60 p-2 text-muted-foreground">
                    {detail.notes}
                  </div>
                )}
              </div>
              {canWrite && (
                <DialogFooter className="flex-wrap gap-2 sm:justify-start">
                  {detail.status === "pending" && (
                    <Button
                      size="sm"
                      disabled={updating}
                      onClick={() => setStatus(detail, "confirmed")}
                    >
                      {t("actions.confirm")}
                    </Button>
                  )}
                  {(detail.status === "pending" || detail.status === "confirmed") && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updating}
                        onClick={() => setStatus(detail, "completed")}
                      >
                        {t("actions.complete")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updating}
                        onClick={() => setStatus(detail, "no_show")}
                      >
                        {t("actions.noShow")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-rose-500"
                        disabled={updating}
                        onClick={() => setStatus(detail, "cancelled")}
                      >
                        {t("actions.cancel")}
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-muted-foreground"
                    disabled={updating}
                    onClick={() => deleteAppointment(detail)}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    {t("actions.delete")}
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ---------- Services dialog ---------- */}
      <Dialog open={servicesOpen} onOpenChange={setServicesOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("services")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div className="mb-2 flex flex-col gap-1.5">
              <Label htmlFor="account-tz">{t("timezone")}</Label>
              <select
                id="account-tz"
                value={accountTz}
                onChange={(e) => saveTimezone(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">UTC</option>
                {timeZones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t("timezoneDesc")}
              </p>
            </div>

            {/* Appointment reminders (migration 040) */}
            <div className="mb-2 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="reminders-enabled">{t("reminders")}</Label>
                <Switch
                  id="reminders-enabled"
                  checked={remindersEnabled}
                  onCheckedChange={saveRemindersEnabled}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("remindersDesc")}
              </p>
              {remindersEnabled && (
                <>
                  <Textarea
                    rows={3}
                    placeholder={DEFAULT_REMINDER_TEMPLATE}
                    value={reminderTemplate}
                    onChange={(e) => setReminderTemplate(e.target.value)}
                    onBlur={saveReminderTemplate}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("reminderTemplateHint")}
                  </p>
                </>
              )}
            </div>
            {services.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("noServices")}</p>
            )}
            {services.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
              >
                <span>
                  {s.name}
                  <span className="ml-2 text-muted-foreground">
                    {s.duration_minutes} min
                    {s.price != null && ` · ${s.price}`}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  aria-label={t("actions.delete")}
                  onClick={() => removeService(s.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div className="mt-2 grid grid-cols-[1fr_90px_90px] gap-2">
              <Input
                placeholder={t("serviceName")}
                value={svcName}
                onChange={(e) => setSvcName(e.target.value)}
              />
              <Input
                type="number"
                min={5}
                step={5}
                placeholder="min"
                value={svcDuration}
                onChange={(e) => setSvcDuration(Number(e.target.value) || 30)}
              />
              <Input
                type="number"
                min={0}
                placeholder={t("price")}
                value={svcPrice}
                onChange={(e) => setSvcPrice(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={addService} disabled={!svcName.trim()}>
              <Plus className="mr-1 h-4 w-4" />
              {t("addService")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
