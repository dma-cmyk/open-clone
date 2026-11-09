"use client";

// 型駆動のテンプレート入力フォーム（報告書 27 §4.3 / §7.1）。
// パラメータ定義（shared の `authoringTemplateParameterSchema`）だけを見て入力欄を作る。
// 独自の見た目は足さず、globals.css の `oc-*` クラスを再利用する。
//
// 各入力は `<label htmlFor>` で明示的に紐づける。`Field`（label で children を包む）だと
// 行数カウンタやヒントがアクセシブル名に混ざるため、フォーム専用の行レイアウトを使う。

import type { ReactNode } from "react";
import type { AuthoringTemplateParameter, PluginTemplateDefinition } from "shared";
import type { FieldErrorMap, FormState, FormValue } from "./form-model";

function fieldLabel(parameter: AuthoringTemplateParameter): string {
  return parameter.required ? `${parameter.label} *` : parameter.label;
}

function fieldHint(parameter: AuthoringTemplateParameter): string | undefined {
  const constraints = parameter.constraints ?? {};
  const hints: string[] = [];
  if (constraints.placeholder) hints.push(`例: ${constraints.placeholder}`);
  if (parameter.type === "string" || parameter.type === "text") {
    if (constraints.minLength !== undefined && constraints.maxLength !== undefined) {
      hints.push(`${constraints.minLength}〜${constraints.maxLength} 文字`);
    } else if (constraints.maxLength !== undefined) {
      hints.push(`${constraints.maxLength} 文字以内`);
    }
  }
  if (parameter.type === "number") {
    hints.push("半角数字");
  }
  if (parameter.type === "stringList" && !(constraints.options && constraints.options.length > 0)) {
    hints.push("1 行に 1 件");
  }
  return hints.length > 0 ? hints.join(" / ") : undefined;
}

function FormRow(props: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="oc-field">
      <label className="oc-label" htmlFor={props.id}>
        {props.label}
      </label>
      {props.hint ? <span className="oc-note">{props.hint}</span> : null}
      {props.children}
      {props.error ? (
        <div className="oc-error oc-small" role="alert">
          {props.error}
        </div>
      ) : null}
    </div>
  );
}

export function TemplateForm(props: {
  template: PluginTemplateDefinition;
  state: FormState;
  errors: FieldErrorMap;
  disabled?: boolean;
  onChange: (key: string, value: FormValue) => void;
}) {
  const { template, state, errors, disabled } = props;

  return (
    <div className="oc-stack">
      {template.parameters.map((parameter) => {
        const value = state[parameter.key];
        const error = errors[parameter.key];
        const constraints = parameter.constraints ?? {};
        const hint = fieldHint(parameter);
        const id = `tpl-${template.id}-${parameter.key}`;
        const label = fieldLabel(parameter);

        if (parameter.type === "boolean") {
          return (
            <div className="oc-field" key={parameter.key}>
              <span className="oc-check">
                <input
                  id={id}
                  type="checkbox"
                  checked={value === true}
                  disabled={disabled}
                  onChange={(event) => props.onChange(parameter.key, event.target.checked)}
                />
                <label className="oc-label" htmlFor={id}>
                  {parameter.label}
                </label>
              </span>
              {hint ? <span className="oc-note">{hint}</span> : null}
              {error ? (
                <div className="oc-error oc-small" role="alert">
                  {error}
                </div>
              ) : null}
            </div>
          );
        }

        if (parameter.type === "stringList" && constraints.options && constraints.options.length > 0) {
          const selected = Array.isArray(value) ? value : [];
          return (
            <div className="oc-field" key={parameter.key} role="group" aria-labelledby={`${id}-label`}>
              <span className="oc-label" id={`${id}-label`}>
                {label}
              </span>
              <span className="oc-row">
                {constraints.options.map((option) => (
                  <label key={option.value} className="oc-check">
                    <input
                      type="checkbox"
                      checked={selected.includes(option.value)}
                      disabled={disabled}
                      onChange={() =>
                        props.onChange(
                          parameter.key,
                          selected.includes(option.value)
                            ? selected.filter((item) => item !== option.value)
                            : [...selected, option.value],
                        )
                      }
                    />
                    {option.label}
                  </label>
                ))}
              </span>
              {error ? (
                <div className="oc-error oc-small" role="alert">
                  {error}
                </div>
              ) : null}
            </div>
          );
        }

        if (parameter.type === "stringList") {
          const text = typeof value === "string" ? value : Array.isArray(value) ? value.join("\n") : "";
          const rows = Math.min(Math.max(constraints.maxItems ?? 6, 4), 10);
          return (
            <FormRow key={parameter.key} id={id} label={label} hint={hint} error={error}>
              <textarea
                id={id}
                className="oc-textarea"
                rows={rows}
                value={text}
                disabled={disabled}
                placeholder={constraints.placeholder}
                onChange={(event) => props.onChange(parameter.key, event.target.value)}
              />
              <span className="oc-note">
                {text.split(/\r?\n/).filter((line) => line.trim().length > 0).length} 行
                {constraints.maxItems !== undefined ? ` / 最大 ${constraints.maxItems} 行` : ""}
              </span>
            </FormRow>
          );
        }

        if (parameter.type === "select") {
          return (
            <FormRow key={parameter.key} id={id} label={label} hint={hint} error={error}>
              <select
                id={id}
                className="oc-input"
                value={typeof value === "string" ? value : ""}
                disabled={disabled}
                onChange={(event) => props.onChange(parameter.key, event.target.value)}
              >
                {(constraints.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormRow>
          );
        }

        if (parameter.type === "text") {
          return (
            <FormRow key={parameter.key} id={id} label={label} hint={hint} error={error}>
              <textarea
                id={id}
                className="oc-textarea"
                rows={parameter.key === "body" ? 6 : 4}
                value={typeof value === "string" ? value : ""}
                disabled={disabled}
                placeholder={constraints.placeholder}
                onChange={(event) => props.onChange(parameter.key, event.target.value)}
              />
              {constraints.maxLength !== undefined ? (
                <span className="oc-note">
                  {typeof value === "string" ? value.length : 0} / {constraints.maxLength} 文字
                </span>
              ) : null}
            </FormRow>
          );
        }

        if (parameter.type === "number") {
          return (
            <FormRow key={parameter.key} id={id} label={label} hint={hint} error={error}>
              <input
                id={id}
                className="oc-input"
                type="number"
                inputMode={constraints.integer === true ? "numeric" : "decimal"}
                min={constraints.min}
                max={constraints.max}
                step={constraints.step ?? (constraints.integer === true ? 1 : undefined)}
                value={typeof value === "string" ? value : ""}
                disabled={disabled}
                onChange={(event) => props.onChange(parameter.key, event.target.value)}
              />
            </FormRow>
          );
        }

        return (
          <FormRow key={parameter.key} id={id} label={label} hint={hint} error={error}>
            <input
              id={id}
              className="oc-input"
              value={typeof value === "string" ? value : ""}
              disabled={disabled}
              placeholder={constraints.placeholder}
              onChange={(event) => props.onChange(parameter.key, event.target.value)}
            />
            {constraints.maxLength !== undefined ? (
              <span className="oc-note">
                {typeof value === "string" ? value.length : 0} / {constraints.maxLength} 文字
              </span>
            ) : null}
          </FormRow>
        );
      })}
    </div>
  );
}