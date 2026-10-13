import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { LINK_LIFETIMES, type LinkLifetime } from "./shareLink.logic";

/** "Link expires in", with the line under it that says what expiry means for this kind of link. */
export function LinkLifetimeRow({
  value,
  onChange,
  helper,
  disabled,
}: {
  readonly value: LinkLifetime;
  readonly onChange: (value: LinkLifetime) => void;
  readonly helper: string;
  readonly disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">Link expires in</p>
        <p className="text-xs text-muted-foreground">{helper}</p>
      </div>
      <div className="w-36 shrink-0">
        <Select
          value={value}
          disabled={disabled}
          onValueChange={(next) => onChange(next as LinkLifetime)}
        >
          <SelectTrigger size="sm" aria-label="Link expires in">
            <SelectValue>{LINK_LIFETIMES.find((option) => option.id === value)?.label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {LINK_LIFETIMES.map((option) => (
              <SelectItem hideIndicator key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}
