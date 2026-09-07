# Argus Operational Agent Roles

**Status:** Scribe accepted; Assistant and Actor reserved for future development
**Decision date:** 2026-09-07

## Purpose

Argus distinguishes operational responsibilities before deciding how many models, processes, prompts, schedulers, or tools implement them. A role is not automatically a service or a model invocation. New runtime boundaries require their own governed contracts, authority, wiring, and evidence.

The conceptual progression is:

**Scribe: What is worth remembering? → Assistant: What deserves attention? → Actor: What should actually be done?**

This progression does not authorize direct wiring or external action between roles.

## Scribe — current contract

Scribe is a session-level recording agent responsible for identifying information from finalized transcript rows that is useful to retain.

It creates **Logged Items**: discrete, meaningful, non-duplicate records such as actions, decisions, open questions, reminders, and other noteworthy information. Every Logged Item remains linked to its source transcript range so its evidence and original context can be recovered.

Scribe records what is worth carrying forward. It does not execute actions, modify external systems, rewrite the transcript, or generate a routine summary for every batch. A valid evaluation may produce zero, one, or multiple Logged Items.

Its responsibility is:

> Determine what happened that is worth retaining.

Scribe is the only one of these three roles currently in implementation scope. Its present local model path is the provider-neutral serial AI lane configured for LM Studio over loopback. LM Studio does not own session memory; Argus constructs each stateless, bounded request.

## Assistant — reserved role

Assistant is a future session-level reasoning and coordination role responsible for evaluating accumulated session state and determining whether anything warrants attention, follow-up, recommendation, delegation, or action.

Assistant may eventually evaluate Logged Items and other established session state to recognize unresolved matters, dependencies, emerging relationships, approaching obligations, or useful interventions. It need not produce output during every evaluation.

Assistant may surface information, recommend a next step, or propose delegation of a well-defined task. It does not receive external execution authority merely by identifying that something should happen.

Its responsibility is:

> Given what is currently known, determine whether anything useful should happen next.

Assistant is a reserved architectural role, not a current runtime contract, service, prompt, queue, or model requirement.

## Actor — reserved role

Actor is a future execution role responsible for performing a specific, authorized action on behalf of the system.

An Actor operates within a narrowly defined capability and permission boundary. Possible future examples include creating a reminder, scheduling an event, sending a message, modifying stored data, interacting with an API, or controlling an external system.

Actors do not determine the broader significance or priority of session information. They receive a defined task and execute it according to explicit permissions, constraints, validation, approval, audit, and failure behavior. Unrelated external capabilities should normally be separate specialized Actors.

Its responsibility is:

> Given an authorized and well-defined task, perform the requested change in the outside world.

Actor is a reserved architectural role, not current authority. No Scribe or future Assistant output may directly cause an external side effect without a separately governed Actor boundary.

## Development boundary

- Current development may refine Scribe batching, bounded context construction, prompting, duplicate suppression, Logged Item contracts, queue behavior, and provenance.
- Assistant and Actor must not be introduced incidentally while implementing Scribe.
- Activating Assistant requires an explicit decision about its inputs, cadence, outputs, authority, user surface, and relationship to Scribe state.
- Activating any Actor requires a capability-specific contract, explicit user authority, least-privilege permission, validation, idempotency, audit evidence, and fail-closed behavior.
- These roles may eventually share a model or use different implementations; the role boundaries remain unchanged.
