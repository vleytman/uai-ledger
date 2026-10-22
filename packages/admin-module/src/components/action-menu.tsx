import {AdminRoleContext,MutationButton} from './admin-permissions';
import {useContext} from 'react';
import { rememberActionTrigger } from './action-focus';
import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  type ReactElement,
  useRef,
} from 'react';
import { Menu } from '@base-ui/react/menu';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@uai/ui/components/button';

function actions(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? actions(child.props.children)
      : [child],
  );
}
/** The same existing handlers, rendered by Base UI with keyboard and focus support. */
export function ActionMenu({
  children,
  label = 'Actions',
}: {
  children: ReactNode;
  label?: string;
}) {
  const role=useContext(AdminRoleContext);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button ref={trigger} size="sm" variant="ghost" aria-label={label} />
        }
      >
        <MoreHorizontal />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup
            className="admin-action-menu"
            finalFocus={() =>
              document.querySelector('dialog[open]') ? false : trigger.current
            }
          >
            <Menu.Group>
              {actions(children).map((child, index) => {
                if (!isValidElement<any>(child)) return null;
                const props = (child as ReactElement<any>).props;
                return (
                  <Menu.Item
                    key={child.key ?? index}
                    className="admin-action-item"
                    data-destructive={
                      props.variant === 'destructive' ||
                      /^(Disable|Cancel|Revoke|Suspend)/.test(
                        String(props.children),
                      ) ||
                      undefined
                    }
                    disabled={props.disabled||(role==='viewer'&&child.type===MutationButton)}
                    onClick={(event) => {
                      rememberActionTrigger(trigger.current);
                      trigger.current?.focus();
                      props.onClick?.(event);
                    }}
                  >
                    {props.children}
                  </Menu.Item>
                );
              })}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
